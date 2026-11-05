/**
 * 启动时用「昨天 + 今天」的流水校正 state。
 *
 * 资金/累计盈亏以 state.json 为准（结算时先写 state 再回写流水），
 * 这里只校正与「窗口推进」相关的字段，防止进程被杀后状态文件落后：
 *   - lastHandledWindow
 *   - lastBettedWindowStart（防重复下注）
 *   - reviewOpen（待复核计数）
 */
import { readState, writeState, type EngineState } from "./stateStore.js";
import { readTrades, type TradeRecord, type TradeStatus } from "./tradeLog.js";

const BET_STATUSES = new Set<TradeStatus>([
  "PENDING",
  "REVIEW",
  "SETTLED",
  "VOID",
  "ERROR",
]);

function isBet(record: TradeRecord): boolean {
  return record.orderId !== null || BET_STATUSES.has(record.status);
}

function latestByWindow(rows: readonly TradeRecord[]): TradeRecord | null {
  let latest: TradeRecord | null = null;
  for (const row of rows) {
    if (!latest || row.windowStart > latest.windowStart) latest = row;
  }
  return latest;
}

export function syncStateFromTrades(): EngineState {
  const state = readState();
  const rows = readTrades();
  if (rows.length === 0) return state;

  const next: EngineState = { ...state };
  const latest = latestByWindow(rows);

  if (
    latest &&
    (!next.lastHandledWindow || latest.windowStart >= next.lastHandledWindow.startMs)
  ) {
    next.lastHandledWindow = {
      startMs: latest.windowStart,
      endMs: latest.windowEnd,
      marketId: latest.marketId,
      topicId: latest.topicId,
    };
  }

  const latestBet = latestByWindow(rows.filter(isBet));
  if (
    latestBet &&
    (next.lastBettedWindowStart === null ||
      latestBet.windowStart > next.lastBettedWindowStart)
  ) {
    next.lastBettedWindowStart = latestBet.windowStart;
  }

  const reviewCount = rows.filter((row) => row.status === "REVIEW").length;
  if (reviewCount > next.reviewOpen) next.reviewOpen = reviewCount;

  const changed =
    next.lastHandledWindow?.startMs !== state.lastHandledWindow?.startMs ||
    next.lastBettedWindowStart !== state.lastBettedWindowStart ||
    next.reviewOpen !== state.reviewOpen;

  if (changed) writeState(next);
  return next;
}
