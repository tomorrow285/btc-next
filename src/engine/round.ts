/**
 * 一个回合（一个 15 分钟窗口）的完整决策与下单流程。
 *
 * 顺序是固定的：
 *   resolveLastHandledWindow → sleepUntil(entryAt) → 超时校验 → 已下单校验
 *   → 刷新窗口直到 OPEN → createTradeRecord → 上一窗口结果
 *   → B0 选方向 → 只查这一侧盘口 → 按深度算均价/倍率/注额
 *   → submitOrder → 流水落盘、状态更新。
 *
 * 任何「本轮不做」的分支都必须落一条带 skipCode 的空单流水。
 *
 * 容错：每个步骤都用 safeSync / safeAsync 包住，失败记 error 日志并跳过本轮，
 * 不让单个异常冒到主循环外。
 */
import type { OrderBook } from "../binance/marketApi.js";
import { config } from "../config/env.js";
import { bestAsk } from "../market/orderBook.js";
import { tradeIdOf, type PredictionWindow } from "../market/window.js";
import { planStakeByDepth } from "../strategy/depthStake.js";
import { effectiveMultiplier } from "../strategy/money.js";
import { dec, formatDecimal } from "../util/decimal.js";
import { errorText, logEvent } from "../util/log.js";
import { safeAsync, safeSync } from "../util/safe.js";
import { addMetrics } from "./metrics.js";
import { notify } from "./notify.js";
import { placeBet } from "./placeBet.js";
import { MARTINGALE_SETTINGS } from "./reset.js";
import type { EngineContext, RoundRun } from "./roundTypes.js";
import {
  adjacentPrevious,
  finishRecord,
  logRoundSkipped,
  markHandled,
  markWindowBet,
  recordNoBet,
  refreshWindowUntilOpen,
  sleepUntil,
} from "./roundSupport.js";
import { resolveLastHandledWindow } from "./settlement/panel.js";
import { readState, writeState, type EngineState } from "./stateStore.js";
import { askBook } from "./trading.js";
import {
  createTradeRecord,
  openTradeForMarket,
  type SkipCode,
  type TradeRecord,
} from "./tradeLog.js";

export type { EngineContext, RoundRun } from "./roundTypes.js";

export async function runRound(
  ctx: EngineContext,
  window: PredictionWindow,
): Promise<RoundRun> {
  const { strategy } = ctx;
  const entryAt = window.startMs + config.timing.entryDelayS * 1000;
  const entryDeadline = entryAt + config.timing.entryWindowS * 1000;
  const tradeId = tradeIdOf(window);
  const fields = { tradeId };

  // 上一窗口的结果属于旁路：拿不到不影响本轮入场。
  await safeAsync(
    "resolve_last_window",
    () => resolveLastHandledWindow(entryAt - config.timing.orderReserveS * 1000),
    undefined,
    fields,
  );
  await sleepUntil(entryAt);

  // 统一的空单收口：落流水 / 写状态的 IO 失败只记日志，不让回合崩掉。
  const finish = (
    record: TradeRecord,
    state: EngineState,
    target: PredictionWindow,
    code: SkipCode,
    fallbackReason?: string,
    extra: Record<string, unknown> = {},
  ): RoundRun => {
    try {
      return finishRecord(record, state, target, code, fallbackReason, extra);
    } catch (error) {
      logEvent(
        "error",
        {
          scope: "finish_record",
          tradeId: tradeIdOf(target),
          message: errorText(error),
        },
        "error",
      );
      return { window: target, openRecord: null };
    }
  };

  // 1. 超时校验
  if (Date.now() > entryDeadline) {
    const reason =
      `错过入场时点（开盘 +${config.timing.entryDelayS}s 起 ` +
      `${config.timing.entryWindowS}s 内未能入场）`;
    safeSync(
      "record_no_bet",
      () => recordNoBet(window, strategy.id, "ENTRY_MISSED", reason),
      undefined,
      fields,
    );
    safeSync("mark_handled", () => markHandled(window), undefined, fields);
    return { window, openRecord: null };
  }

  // 2. 当前窗口已下单校验（状态 + 未结流水双重防护）
  const loaded = safeSync("read_state", () => readState(), null, fields);
  if (!loaded) return { window, openRecord: null };
  let state = loaded;

  const existingOpenBet = safeSync(
    "open_trade_lookup",
    () => openTradeForMarket(window.marketId),
    undefined,
    fields,
  );
  // 流水读取失败时无法确认是否已经下过注：保守放弃本轮，绝不重复下单。
  if (existingOpenBet === undefined) return { window, openRecord: null };

  if (state.lastBettedWindowStart === window.startMs || existingOpenBet) {
    if (existingOpenBet && state.lastBettedWindowStart !== window.startMs) {
      state = markWindowBet(state, window);
      safeSync("write_state", () => writeState(state), undefined, fields);
    }
    if (!existingOpenBet) {
      safeSync(
        "record_no_bet",
        () =>
          recordNoBet(
            window,
            strategy.id,
            "ALREADY_BET",
            `本窗口已下过注（lastBettedWindowStart=${window.startMs}），跳过`,
          ),
        undefined,
        fields,
      );
    } else {
      // 已有未结流水时不再追加空单行，但仍要留下本轮跳过的事件。
      logRoundSkipped(
        window,
        "ALREADY_BET",
        `本窗口已下过注（windowStart=${window.startMs}），跳过`,
        { hasOpenBet: true },
      );
    }
    return { window, openRecord: existingOpenBet };
  }

  // 3. 刷新窗口，直到 tradingStatus 为 OPEN 或超过下单时间限制
  const fresh = await safeAsync(
    "refresh_window",
    () => refreshWindowUntilOpen(window.startMs, entryDeadline),
    null,
    fields,
  );
  if (!fresh) {
    safeSync(
      "record_no_bet",
      () =>
        recordNoBet(
          window,
          strategy.id,
          "TRADING_CLOSED",
          `下单时间限制内窗口状态始终不是 OPEN（${formatDecimal(
            (entryDeadline - window.startMs) / 1000,
            0,
          )}s）`,
        ),
      undefined,
      fields,
    );
    safeSync("mark_handled", () => markHandled(window), undefined, fields);
    return { window, openRecord: null };
  }

  safeSync("mark_handled", () => markHandled(fresh), undefined, fields);

  const reloaded = safeSync("read_state", () => readState(), null, fields);
  if (!reloaded) return { window, openRecord: null };
  state = reloaded;

  // 4. 先建流水，后续任何跳过都能完整落盘
  const record = safeSync(
    "create_record",
    () => createTradeRecord(fresh, strategy.id),
    null,
    fields,
  );
  if (!record) return { window, openRecord: null };

  const previous = adjacentPrevious(state.lastWindowResult, fresh);
  record.previousSide = previous?.outcome ?? null;
  record.previousChangePct = previous?.changePct ?? null;

  logEvent("round_start", {
    tradeId,
    windowStart: fresh.startMs,
    windowEnd: fresh.endMs,
    marketId: fresh.marketId,
    topicId: fresh.topicId,
    tradingStatus: fresh.tradingStatus,
    previousOutcome: previous?.outcome ?? null,
    previousChangePct: previous?.changePct ?? null,
  });

  // 5. 上一窗口结算结果：查不到 / DRAW 都主动跳过
  if (!previous) {
    return finish(
      record,
      state,
      fresh,
      "PREVIOUS_UNAVAILABLE",
      "查不到上一窗口结算结果，本轮主动跳过",
    );
  }
  if (previous.outcome === "DRAW") {
    return finish(
      record,
      state,
      fresh,
      "PREVIOUS_DRAW",
      "上一窗口 DRAW，没有获胜方向，本轮主动跳过",
    );
  }

  // 6. B0 选方向
  const decision = safeSync(
    "strategy_decide",
    () => strategy.decide(previous),
    null,
    fields,
  );
  if (!decision) {
    return finish(record, state, fresh, "DECIDE_SKIP", "策略决策异常，本轮主动跳过");
  }

  addMetrics(decision.action === "BUY" ? { decisionsBuy: 1 } : { decisionsSkip: 1 });
  logEvent("decision", {
    tradeId,
    action: decision.action,
    side: decision.action === "BUY" ? decision.side : null,
    reason: decision.reason,
    previousOutcome: previous.outcome,
    previousChangePct: previous.changePct,
  });

  if (decision.action === "SKIP") {
    return finish(record, state, fresh, "DECIDE_SKIP", decision.reason);
  }

  record.side = decision.side;
  const side = decision.side;

  // 7. 只查要买的那一侧盘口
  let book: OrderBook;
  try {
    book = await askBook(fresh, side);
  } catch (error) {
    record.reason = `${side} 盘口读取失败：${errorText(error)}，本轮主动跳过`;
    return finish(record, state, fresh, "BOOK_ERROR", undefined, {
      error: errorText(error),
    });
  }

  const ask = bestAsk(book);
  if (ask === null) {
    record.reason = `${side} 方向没有卖单，本轮主动跳过`;
    return finish(record, state, fresh, "NO_ASK");
  }
  record.askPrice = ask;
  logEvent("book", { tradeId, side, ask, askLevels: book.asks.length });

  // 8. 按盘口深度算可成交均价 / 有效倍率 / 注额
  const plan = safeSync(
    "plan_stake",
    () => planStakeByDepth(book.asks, state.bankroll, MARTINGALE_SETTINGS),
    null,
    fields,
  );
  if (!plan) {
    record.reason = "盘口深度计算异常，本轮主动跳过";
    return finish(record, state, fresh, "NO_DEPTH");
  }

  // 门槛按「基础注码的可成交均价」判断；记录里保留计划注额的真实均价。
  const gates = safeSync(
    "compute_gates",
    () => {
      const gateQuotedMultiple = dec(1).div(plan.baseExecPrice).toFixed();
      const gateEffective = effectiveMultiplier(
        gateQuotedMultiple,
        config.strategy.feeRate,
      );
      const quotedMultiple = dec(1).div(plan.execPrice).toFixed();
      const effective = effectiveMultiplier(quotedMultiple, config.strategy.feeRate);
      return { gateQuotedMultiple, gateEffective, quotedMultiple, effective };
    },
    null,
    fields,
  );
  if (!gates) {
    record.reason = "倍率计算异常，本轮主动跳过";
    return finish(record, state, fresh, "DECIDE_SKIP");
  }
  const { gateQuotedMultiple, gateEffective, quotedMultiple, effective } = gates;

  record.execPrice = plan.execPrice;
  record.depthCapacityUsdt = plan.capacityUsdt;
  record.quotedMultiple = quotedMultiple;
  record.amountUsdt = plan.amountUsdt;
  record.totalLossBefore = state.bankroll.totalLoss;

  logEvent("depth_plan", {
    tradeId,
    side,
    ask,
    baseExecPrice: plan.baseExecPrice,
    execPrice: plan.execPrice,
    gateQuotedMultiple,
    gateEffectiveMultiple: gateEffective.toFixed(),
    quotedMultiple,
    effectiveMultiple: effective.toFixed(),
    amountUsdt: plan.amountUsdt,
    capacityUsdt: plan.capacityUsdt,
    depthShortfall: plan.depthShortfall,
    totalLoss: state.bankroll.totalLoss,
    lossStreak: state.bankroll.lossStreak,
  });

  if (gateEffective.lt(config.strategy.minEffectiveMultiplier)) {
    const reason =
      `盘口深度折算有效倍率 ${gateEffective.toFixed(4)}` +
      `（报价 ${formatDecimal(gateQuotedMultiple, 4)}）` +
      ` < ${formatDecimal(config.strategy.minEffectiveMultiplier, 4)}，本轮主动跳过`;
    record.reason = reason;
    notify(reason, {
      tradeId,
      marketId: fresh.marketId,
      side,
      effectiveMultiple: gateEffective.toFixed(4),
    });
    return finish(record, state, fresh, "MULTIPLE_BELOW_GATE");
  }

  // 9. 深度接不下时只告警 + 通知，不拦截下单
  if (plan.depthShortfall) {
    const warning =
      `盘口深度只能承接 ${formatDecimal(plan.capacityUsdt, 4)}u，` +
      `计划注额 ${formatDecimal(plan.amountUsdt, 4)}u 可能无法全部成交（不拦截下单）`;
    record.warning = warning;
    logEvent("depth_shortfall", {
      tradeId,
      side,
      capacityUsdt: plan.capacityUsdt,
      amountUsdt: plan.amountUsdt,
    }, "warn");
    notify(warning, {
      tradeId,
      marketId: fresh.marketId,
      side,
      capacityUsdt: plan.capacityUsdt,
      amountUsdt: plan.amountUsdt,
    });
  }

  // 10. 下单
  return safeAsync(
    "place_bet",
    () => placeBet(ctx, state, fresh, record, tradeId),
    { window: fresh, openRecord: null },
    fields,
  );
}
