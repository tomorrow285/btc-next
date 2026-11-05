/**
 * 结算入账与收口：账本更新、流水回写、待复核计数。
 *
 * 口径：
 *   - 盈亏 = 实际成交份额 × 每份派彩 − 实扣金额（全部十进制运算）；
 *   - 拿不到证据 → 挂 REVIEW，不猜、不停机；
 *   - 空单（订单历史确认未成交）不碰账本与累计盈亏。
 */
import type { Side, WindowOutcome } from "../../domain.js";
import { tradeIdOf } from "../../market/window.js";
import { pnlFromFill, resultLabel, settleBankroll } from "../../strategy/money.js";
import { dec, type DecimalInput } from "../../util/decimal.js";
import { logEvent } from "../../util/log.js";
import { addMetrics } from "../metrics.js";
import { readState, writeState } from "../stateStore.js";
import {
  isOpen,
  updateTrade,
  type ResultSource,
  type TradeRecord,
} from "../tradeLog.js";

export interface SettlementInput {
  pnl: string;
  /** 盘面已知时是真实结果；链上对账时可传 null，由盈亏反推。 */
  outcome: WindowOutcome | null;
  payout: string | null;
  source: ResultSource;
  late: boolean;
  filledShares?: string;
  filledUsdt?: string;
  resultText: string;
}

export const matchesOpenRecord =
  (target: TradeRecord) =>
  (record: TradeRecord): boolean =>
    record.marketId === target.marketId && isOpen(record);

export function bookSettlement(target: TradeRecord, input: SettlementInput): void {
  const wasReview = target.status === "REVIEW";
  const pnl = dec(input.pnl);
  const filledUsdt = dec(input.filledUsdt ?? target.filledUsdt ?? 0);
  const state = readState();

  const next = {
    ...state,
    bankroll: settleBankroll(state.bankroll, pnl),
    realizedPnl: dec(state.realizedPnl).plus(pnl).toFixed(),
    stakedUsdt: dec(state.stakedUsdt).plus(filledUsdt).toFixed(),
    wins: state.wins + (pnl.gt(0) ? 1 : 0),
    losses: state.losses + (pnl.lt(0) ? 1 : 0),
    flats: state.flats + (pnl.eq(0) ? 1 : 0),
    rounds: state.rounds + 1,
    lastRoundAt: Date.now(),
    reviewOpen: wasReview ? Math.max(0, state.reviewOpen - 1) : state.reviewOpen,
    reviewsResolved: wasReview ? state.reviewsResolved + 1 : state.reviewsResolved,
  };

  writeState(next);
  updateTrade(matchesOpenRecord(target), {
    status: "SETTLED",
    pnl: pnl.toFixed(),
    error: null,
    resultSide: input.outcome ?? inferOutcome(pnl, target.side),
    settleValuePerShare: input.payout,
    resultSource: input.source,
    resolvedLate: input.late,
    resolvedAt: Date.now(),
    ...(input.filledShares !== undefined ? { filledShares: input.filledShares } : {}),
    ...(input.filledUsdt !== undefined ? { filledUsdt: input.filledUsdt } : {}),
    totalLossAfter: next.bankroll.totalLoss,
    realizedPnlAfter: next.realizedPnl,
    ts: Date.now(),
  });

  addMetrics({
    settlements: 1,
    settlementsPanel: input.source === "panel" ? 1 : 0,
    settlementsChain: input.source === "chain" ? 1 : 0,
    reviewsResolved: wasReview ? 1 : 0,
  });

  logEvent("settlement", {
    tradeId: tradeIdOf(target),
    marketId: target.marketId,
    source: input.source,
    late: input.late,
    outcome: input.outcome,
    pnl: pnl.toFixed(),
    result: input.resultText,
    stakedUsdt: input.filledUsdt ?? target.filledUsdt,
    totalLoss: next.bankroll.totalLoss,
    lossStreak: next.bankroll.lossStreak,
    realizedPnl: next.realizedPnl,
  });
}

/** 由真实成交明细算一笔注的盈亏。 */
export function pnlOfFill(
  filledShares: DecimalInput,
  filledUsdt: DecimalInput,
  payout: DecimalInput,
): string {
  return pnlFromFill(filledShares, filledUsdt, payout);
}

export function resultTextOf(outcome: WindowOutcome, pnl: DecimalInput): string {
  const label = outcome === "DRAW" ? "平局" : outcome === "UP" ? "上涨" : "下跌";
  return `${label} ${resultLabel(pnl)}`;
}

function inferOutcome(pnl: DecimalInput, side: Side | null): WindowOutcome | null {
  const value = dec(pnl);
  if (!side || value.eq(0)) return null;
  if (value.gt(0)) return side;
  return side === "UP" ? "DOWN" : "UP";
}

/** 标记待复核：只影响挂账计数，不改账本与累计盈亏。 */
export function markReview(record: TradeRecord, reason: string): void {
  const state = readState();
  const alreadyReview = record.status === "REVIEW";

  if (!alreadyReview) addMetrics({ reviewsOpened: 1 });

  writeState({
    ...state,
    reviewOpen: alreadyReview ? state.reviewOpen : state.reviewOpen + 1,
    lastError: reason,
  });

  updateTrade(matchesOpenRecord(record), {
    status: "REVIEW",
    error: reason,
    resolvedAt: null,
    resolvedLate: null,
    catchUpTries: record.catchUpTries ?? 0,
  });

  logEvent(
    "review",
    {
      tradeId: tradeIdOf(record),
      marketId: record.marketId,
      reason,
      outcome: record.resultSide,
    },
    "warn",
  );
}

/** 收口为空单：一分钱没花，不碰账本与累计盈亏。 */
export function closeAsVoid(record: TradeRecord, tries: number, note?: string): void {
  const reason = note ?? "订单历史确认未成交（空单，无盈亏）";
  let state = readState();

  if (record.status === "REVIEW") {
    state = {
      ...state,
      reviewOpen: Math.max(0, state.reviewOpen - 1),
      reviewsResolved: state.reviewsResolved + 1,
    };
    writeState(state);
    addMetrics({ reviewsResolved: 1 });
  }

  updateTrade(matchesOpenRecord(record), {
    status: "VOID",
    skipCode: "ORDER_VOID",
    pnl: "0",
    filledUsdt: "0",
    filledShares: "0",
    resultSource: "order-history",
    resolvedAt: Date.now(),
    catchUpTries: tries,
    error: reason,
    totalLossAfter: state.bankroll.totalLoss,
    realizedPnlAfter: state.realizedPnl,
  });

  logEvent("void", {
    tradeId: tradeIdOf(record),
    marketId: record.marketId,
    orderId: record.orderId,
    reason,
    tries,
  });
}

export function markError(record: TradeRecord, tries: number, reason: string): void {
  const state = readState();
  if (record.status === "REVIEW") {
    writeState({ ...state, reviewOpen: Math.max(0, state.reviewOpen - 1) });
  }
  updateTrade(matchesOpenRecord(record), {
    status: "ERROR",
    error: reason,
    catchUpTries: tries,
    ts: Date.now(),
  });
  logEvent(
    "error",
    {
      tradeId: tradeIdOf(record),
      marketId: record.marketId,
      reason,
      tries,
    },
    "error",
  );
}
