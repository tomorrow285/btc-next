/**
 * 盘面判定与收盘结算（快路径）。
 *
 * 口径：
 *   - 收盘后用手上的 topicId 直查盘面，比较开盘价/到期价自判输赢，不干等链上派彩；
 *   - 无论本窗口有没有下注，都记录窗口结果供下一窗口策略使用；
 *   - 拿不到结果就挂 REVIEW，绝不猜测、不停机。
 */
import type { PreviousWindowResult } from "../../domain.js";
import { config } from "../../config/env.js";
import {
  describeOutcome,
  judgeWindowPrices,
  payoutPerShare,
  type WindowJudgement,
} from "../../market/result.js";
import {
  tradeIdOf,
  windowByTopicId,
  type PredictionWindow,
} from "../../market/window.js";
import { sleep } from "../../util/async.js";
import { dec } from "../../util/decimal.js";
import { errorText, logEvent } from "../../util/log.js";
import { readState, writeState } from "../stateStore.js";
import type { TradeRecord } from "../tradeLog.js";
import {
  bookSettlement,
  markReview,
  pnlOfFill,
  resultTextOf,
} from "./ledger.js";

/**
 * 收盘后反复读官方盘面，直到开盘价与到期价都能拿到。
 * 预算内拿不到返回 null，调用方挂 REVIEW 或下一轮再试。
 */
export async function judgeWindow(
  window: Pick<PredictionWindow, "topicId" | "marketId" | "startMs">,
  deadlineMs: number,
): Promise<WindowJudgement | null> {
  const tradeId = tradeIdOf(window);

  for (let attempt = 1; ; attempt++) {
    let waitReason = "prices_not_ready";
    try {
      const detail = await windowByTopicId(window.topicId);
      const judgement = judgeWindowPrices(detail.openPrice, detail.endPrice);
      if (judgement) return judgement;
    } catch (error) {
      waitReason = errorText(error);
      logEvent("error", { scope: "judge_window", tradeId, message: waitReason }, "warn");
    }

    if (Date.now() >= deadlineMs) return null;

    logEvent(
      "judge_wait",
      {
        tradeId,
        marketId: window.marketId,
        topicId: window.topicId,
        attempt,
        remainingMs: Math.max(0, deadlineMs - Date.now()),
        reason: waitReason,
      },
      "info",
    );
    await sleep(5_000);
  }
}

export function toPreviousResult(
  window: PredictionWindow,
  judgement: WindowJudgement,
): PreviousWindowResult {
  return {
    windowStart: window.startMs,
    windowEnd: window.endMs,
    marketId: window.marketId,
    topicId: window.topicId,
    outcome: judgement.outcome,
    openPrice: judgement.openPrice,
    endPrice: judgement.endPrice,
    changePct: judgement.changePct,
    judgedAt: Date.now(),
  };
}

/** 保存窗口结果（无论本窗口有没有下注），供下一窗口策略使用。 */
export function recordWindowResult(
  window: PredictionWindow,
  judgement: WindowJudgement,
): void {
  const state = readState();
  writeState({ ...state, lastWindowResult: toPreviousResult(window, judgement) });

  logEvent("window_result", {
    tradeId: tradeIdOf(window),
    windowStart: window.startMs,
    windowEnd: window.endMs,
    marketId: window.marketId,
    outcome: judgement.outcome,
    openPrice: judgement.openPrice,
    endPrice: judgement.endPrice,
    changePct: judgement.changePct,
  });
}

/**
 * 如果上一处理窗口已经收盘但结果还没落库，就补一次判定。
 * 进程重启、或收盘时盘面未就绪时会走到这里。
 */
export async function resolveLastHandledWindow(deadlineMs: number): Promise<void> {
  const state = readState();
  const handled = state.lastHandledWindow;

  if (!handled) return;
  if (handled.endMs > Date.now()) return;
  if (state.lastWindowResult?.windowStart === handled.startMs) return;

  const judgement = await judgeWindow(handled, deadlineMs);
  if (!judgement) {
    logEvent(
      "window_result_missing",
      { marketId: handled.marketId, windowStart: handled.startMs },
      "warn",
    );
    return;
  }

  writeState({
    ...state,
    lastWindowResult: {
      windowStart: handled.startMs,
      windowEnd: handled.endMs,
      marketId: handled.marketId,
      topicId: handled.topicId,
      outcome: judgement.outcome,
      openPrice: judgement.openPrice,
      endPrice: judgement.endPrice,
      changePct: judgement.changePct,
      judgedAt: Date.now(),
    },
  });

  logEvent("window_result", {
    tradeId: tradeIdOf(handled),
    windowStart: handled.startMs,
    windowEnd: handled.endMs,
    marketId: handled.marketId,
    outcome: judgement.outcome,
    changePct: judgement.changePct,
    recovered: true,
  });
}

/** 用收盘时的快路径结算一笔已成交的注。 */
export function settleOpenRecord(
  record: TradeRecord,
  judgement: WindowJudgement,
): void {
  if (
    record.side === null ||
    record.filledShares === null ||
    record.filledUsdt === null ||
    !dec(record.filledShares).gt(0)
  ) {
    markReview(record, "成交凭据不足，等待补齐");
    return;
  }

  const payout = payoutPerShare(record.side, judgement.outcome);
  const pnl = pnlOfFill(record.filledShares, record.filledUsdt, payout);

  bookSettlement(record, {
    pnl,
    outcome: judgement.outcome,
    payout,
    source: "panel",
    late: false,
    resultText: resultTextOf(judgement.outcome, pnl),
  });
}

/**
 * 等收盘 + judgeDelay，判定窗口结果；本窗口有未结订单则当场入账。
 * 由主循环在 catchUpOnce 之后调用。
 */
export async function settleAfterClose(round: {
  window: PredictionWindow;
  openRecord: TradeRecord | null;
}): Promise<void> {
  const { window, openRecord } = round;
  const settleAt = window.endMs + config.timing.judgeDelayS * 1000;

  if (Date.now() < settleAt) {
    logEvent("settlement_wait", {
      tradeId: tradeIdOf(window),
      windowStart: window.startMs,
      windowEnd: window.endMs,
      settleAt,
      waitMs: settleAt - Date.now(),
      hasOpenRecord: openRecord !== null,
    });
    await sleep(settleAt - Date.now());
  }

  const nextEntryAt = window.endMs + config.timing.entryDelayS * 1000;
  // 三个上限取最小：单个窗口的重试预算、**盘面结束 + JUDGE_DEADLINE_S 的硬截止**、
  // 下一窗口入场前要留出的下单时间。硬截止保证「收盘后不会无限等盘面」。
  const judgeDeadline = Math.min(
    Date.now() + config.timing.judgeBudgetS * 1000,
    window.endMs + config.timing.judgeDeadlineS * 1000,
    nextEntryAt - config.timing.orderReserveS * 1000,
  );

  const judgement = await judgeWindow(window, judgeDeadline);
  if (!judgement) {
    logEvent(
      "window_result_missing",
      { tradeId: tradeIdOf(window), marketId: window.marketId, openRecord: openRecord !== null },
      "warn",
    );
    if (openRecord) markReview(openRecord, "收盘后盘面未就绪，等待补齐");
    return;
  }

  recordWindowResult(window, judgement);
  logEvent("window_judged", {
    tradeId: tradeIdOf(window),
    windowStart: window.startMs,
    outcome: judgement.outcome,
    changePct: judgement.changePct,
    result: describeOutcome(judgement.outcome),
  });

  if (openRecord) settleOpenRecord(openRecord, judgement);
}
