/**
 * 马丁格尔账本的「重新初始化」。
 *
 * 只清账本（欠账 / 连败），不动累计已实现盈亏，也不停机。
 * 调用点：启动时一次；之后每轮 settleAfterClose 之后立即检查。
 */
import { config } from "../config/env.js";
import {
  emptyBankroll,
  resetReason,
  type MartingaleSettings,
} from "../strategy/money.js";
import { logEvent } from "../util/log.js";
import { notify } from "./notify.js";
import { readState, writeState, type EngineState } from "./stateStore.js";

/** B0 的马丁格尔参数（费率是市场级参数，单独拼进来）。 */
export const MARTINGALE_SETTINGS: MartingaleSettings = {
  feeRate: config.strategy.feeRate,
  ...config.strategy.b0,
};

export function applyResetIfNeeded(state: EngineState = readState()): EngineState {
  const reason = resetReason(state.bankroll, MARTINGALE_SETTINGS);
  if (!reason) return state;

  const next: EngineState = {
    ...state,
    bankroll: emptyBankroll(),
    resets: state.resets + 1,
    lastResetAt: Date.now(),
    lastResetReason: reason,
  };
  writeState(next);

  logEvent("reset", {
    reason,
    totalLossBefore: state.bankroll.totalLoss,
    lossStreakBefore: state.bankroll.lossStreak,
    realizedPnl: state.realizedPnl,
    resets: next.resets,
  });

  // 重新初始化是风控事件，和 btc-trade 一样立即推，不等汇总。
  notify(
    `🔄 重新初始化（账本清零）\n` +
      `原因：${reason}\n` +
      `清零前：TOTAL_LOSS ${state.bankroll.totalLoss}u / 连败 ${state.bankroll.lossStreak}\n` +
      `累计已实现盈亏：${state.realizedPnl}u（未清零）\n` +
      `累计重置次数：${next.resets}`,
    {
      scope: "reset",
      totalLossBefore: state.bankroll.totalLoss,
      lossStreakBefore: state.bankroll.lossStreak,
      resets: next.resets,
    },
    { key: `reset:${next.resets}` },
  );
  return next;
}
