/** runRound 的辅助函数：时间等待、流水收口、成交后校验、窗口刷新。 */
import type { PreviousWindowResult, StrategyId } from "../domain.js";
import {
  resolveWindow,
  tradeIdOf,
  type PredictionWindow,
} from "../market/window.js";
import { sleep } from "../util/async.js";
import {
  dec,
  decOrNull,
  formatDecimal,
  maxDecimal,
} from "../util/decimal.js";
import { logEvent } from "../util/log.js";
import { safeAsync } from "../util/safe.js";
import { readState, writeState, type EngineState } from "./stateStore.js";
import {
  appendTrade,
  createTradeRecord,
  type SkipCode,
  type TradeRecord,
} from "./tradeLog.js";

/** 成交均价偏离计划均价超过该值就告警（只告警，不拦截）。 */
const FILL_DRIFT_WARN_BPS = 300;
/** 若赢只能补回欠账的比例低于该值就告警（只告警，不拦截）。 */
const RECOVERY_RATIO_WARN = dec("0.9");

export async function sleepUntil(timestampMs: number): Promise<void> {
  const waitMs = timestampMs - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

/** 只接受 windowEnd 等于当前窗口 startMs 的紧邻结果。 */
export function adjacentPrevious(
  previous: PreviousWindowResult | null,
  window: PredictionWindow,
): PreviousWindowResult | null {
  if (!previous) return null;
  return previous.windowEnd === window.startMs ? previous : null;
}

export function markHandled(window: PredictionWindow): void {
  const state = readState();
  writeState({
    ...state,
    lastHandledWindow: {
      startMs: window.startMs,
      endMs: window.endMs,
      marketId: window.marketId,
      topicId: window.topicId,
    },
  });
}

/** 记录「本窗口已下过单」，用于防止重启后对同一窗口重复下注。 */
export function markWindowBet(state: EngineState, window: PredictionWindow): EngineState {
  return { ...state, lastBettedWindowStart: window.startMs };
}

/** 定位同窗口的未结流水，用于回填终态/成交字段。 */
export const matchesWindowRecord =
  (target: TradeRecord) =>
  (row: TradeRecord): boolean =>
    row.marketId === target.marketId &&
    row.windowStart === target.windowStart &&
    (row.status === "PENDING" || row.status === "REVIEW");

/**
 * 统一的「本轮不下注」事件。
 *
 * 每个跳过分支都必须经过这里（而不是只落流水），这样按 tradeId 复盘时
 * 一定能看到「为什么这个窗口没有下单」。
 */
export function logRoundSkipped(
  window: Pick<PredictionWindow, "startMs" | "endMs" | "marketId" | "topicId">,
  code: SkipCode,
  reason: string,
  extra: Record<string, unknown> = {},
): void {
  logEvent(
    "round_skipped",
    {
      tradeId: tradeIdOf(window),
      windowStart: window.startMs,
      windowEnd: window.endMs,
      marketId: window.marketId,
      code,
      reason,
      ...extra,
    },
    "warn",
  );
}

/**
 * 结束一个不产生未结订单的回合：记录流水并落盘状态。
 * `code` 是兜底原因码，保证每一笔空单流水都有机器可读的原因。
 */
export function finishRecord(
  record: TradeRecord,
  state: EngineState,
  window: PredictionWindow,
  code: SkipCode,
  fallbackReason?: string,
  extra: Record<string, unknown> = {},
): { window: PredictionWindow; openRecord: null } {
  if (record.skipCode === null) record.skipCode = code;
  if (record.reason === "" && fallbackReason) record.reason = fallbackReason;
  if (record.reason === "") record.reason = "策略未产生决策";

  record.ts = Date.now();
  record.totalLossAfter = state.bankroll.totalLoss;
  record.realizedPnlAfter = state.realizedPnl;
  writeState(state);
  appendTrade(record);

  logRoundSkipped(window, record.skipCode ?? code, record.reason, {
    status: record.status,
    side: record.side,
    ...extra,
  });
  return { window, openRecord: null };
}

/** 还没走到回合记录就决定不下注时（错过入场 / 窗口不 OPEN 等），直接落一条空单流水。 */
export function recordNoBet(
  window: Pick<PredictionWindow, "startMs" | "endMs" | "marketId" | "topicId">,
  strategy: StrategyId,
  code: SkipCode,
  reason: string,
): void {
  try {
    const record = createTradeRecord(window, strategy);
    record.skipCode = code;
    record.reason = reason;
    record.ts = Date.now();

    const state = readState();
    record.totalLossAfter = state.bankroll.totalLoss;
    record.realizedPnlAfter = state.realizedPnl;
    appendTrade(record);

    logRoundSkipped(window, code, reason, { status: record.status });
  } catch (error) {
    // 记流水失败不能拖垮主循环（尤其不能盖住原始错误）。
    logEvent(
      "error",
      { scope: "record_no_bet", tradeId: tradeIdOf(window), message: String(error) },
      "warn",
    );
  }
}

/**
 * 成交后校验：实际均价 vs 计划均价、若赢能补回多少欠账。
 *
 * 只写流水 + 告警，**不拦截、不回滚** —— 单已经成交，拦也拦不住。
 */
export function verifyFill(
  record: TradeRecord,
  plannedAmountUsdt: string,
  debtBefore: string,
): void {
  const shares = decOrNull(record.filledShares);
  const spent = decOrNull(record.filledUsdt);
  if (shares === null || spent === null || !shares.gt(0) || !spent.gt(0)) return;

  const avg = spent.div(shares);
  record.avgFillPrice = avg.toFixed();

  const planned = decOrNull(record.execPrice ?? record.askPrice);
  if (planned !== null && planned.gt(0)) {
    record.fillDriftBps = avg.div(planned).minus(1).times(10_000).toFixed(2);
  }

  // 买对时每份派彩 1 USDT，若赢的毛利 = 实际到手份额 − 实扣。
  const winPnl = shares.minus(spent);
  record.winPnlIfWin = winPnl.toFixed();

  const debt = dec(debtBefore);
  if (debt.gt(0)) {
    record.recoveryRatio = winPnl.div(debt).toFixed(4);
  }

  // 保留下单前已经写下的告警（如深度不足），再追加成交后校验的发现。
  const warns: string[] = record.warning ? [record.warning] : [];
  if (
    record.fillDriftBps !== null &&
    dec(record.fillDriftBps).abs().gt(FILL_DRIFT_WARN_BPS)
  ) {
    warns.push(
      `成交均价 ${avg.toFixed(6)} 偏离计划 ${planned?.toFixed(6)} ` +
        `${dec(record.fillDriftBps).gt(0) ? "+" : ""}${formatDecimal(record.fillDriftBps, 0)}bps` +
        `（阈值 ${FILL_DRIFT_WARN_BPS}）`,
    );
  }
  if (
    record.recoveryRatio !== null &&
    dec(record.recoveryRatio).lt(RECOVERY_RATIO_WARN)
  ) {
    warns.push(
      `若本局赢只能补回欠账的 ${dec(record.recoveryRatio).times(100).toFixed(1)}%` +
        `（${winPnl.toFixed(2)}u / ${debt.toFixed(2)}u，` +
        `阈值 ${RECOVERY_RATIO_WARN.times(100).toFixed(0)}%）`,
    );
  }
  const plannedAmount = dec(plannedAmountUsdt);
  const mismatch = spent.minus(plannedAmount).abs();
  if (
    plannedAmount.gt(0) &&
    mismatch.gt(maxDecimal(dec("0.01"), plannedAmount.times("0.001")))
  ) {
    warns.push(`实扣 ${spent.toFixed(4)}u 与计划注额 ${plannedAmount.toFixed(4)}u 不一致`);
  }
  record.warning = warns.length > 0 ? warns.join("；") : null;

  logEvent(
    "fill_check",
    {
      tradeId: tradeIdOf(record),
      avgFillPrice: record.avgFillPrice,
      plannedPrice: planned?.toFixed(6) ?? null,
      fillDriftBps: record.fillDriftBps,
      winPnlIfWin: record.winPnlIfWin,
      recoveryRatio: record.recoveryRatio,
      warning: record.warning,
    },
    record.warning ? "warn" : "info",
  );
}

/**
 * 刷新窗口直到 tradingStatus 为 OPEN，或超过下单时间限制。
 * 失败返回 null，由调用方按 TRADING_CLOSED 记空单。
 */
export async function refreshWindowUntilOpen(
  startMs: number,
  deadlineMs: number,
): Promise<PredictionWindow | null> {
  for (;;) {
    // 单次查询失败（网络抖动 / 接口 5xx）只记日志，继续轮询到下单时间限制。
    const fresh = await safeAsync(
      "refresh_window_query",
      () => resolveWindow(startMs),
      null,
      { windowStart: startMs },
    );
    if (fresh?.tradingStatus === "OPEN") return fresh;

    logEvent(
      "window_refresh",
      {
        tradeId: fresh ? tradeIdOf(fresh) : null,
        windowStart: startMs,
        tradingStatus: fresh?.tradingStatus ?? null,
        remainingMs: Math.max(0, deadlineMs - Date.now()),
      },
      "warn",
    );

    if (Date.now() >= deadlineMs) return null;
    await sleep(Math.min(1_000, deadlineMs - Date.now()));
  }
}
