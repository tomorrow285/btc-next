/** 下单与落盘：submitOrder 之前的所有校验已经在 runRound 里完成。 */
import type { PredictionWindow } from "../market/window.js";
import { errorText, logEvent } from "../util/log.js";
import type { EngineContext, RoundRun } from "./roundTypes.js";
import {
  finishRecord,
  logRoundSkipped,
  markWindowBet,
  matchesWindowRecord,
  verifyFill,
} from "./roundSupport.js";
import { notify } from "./notify.js";
import { writeState, type EngineState } from "./stateStore.js";
import { submitOrder, type OrderAttempt } from "./trading.js";
import {
  appendTrade,
  updateTrade,
  type TradeRecord,
} from "./tradeLog.js";

export async function placeBet(
  ctx: EngineContext,
  state: EngineState,
  window: PredictionWindow,
  record: TradeRecord,
  tradeId: string,
): Promise<RoundRun> {
  const { wallet, funding } = ctx;
  const amountUsdt = record.amountUsdt;
  if (amountUsdt === null || record.side === null) {
    return finishRecord(record, state, window, "DECIDE_SKIP", "缺少方向或注额");
  }

  const side = record.side;
  record.status = "PENDING";
  let currentState = state;
  let recordPersisted = false;

  const persistSubmittedOrder = (orderId: string) => {
    record.orderId = orderId;
    record.status = "PENDING";

    if (!recordPersisted) {
      // 先落流水再写状态：若中间被杀，重启时靠流水里的未结记录阻止重复下注。
      appendTrade(record);
      recordPersisted = true;
      currentState = markWindowBet(currentState, window);
      writeState(currentState);
      logEvent("trade_persisted", { tradeId, orderId, amountUsdt });
    } else {
      updateTrade(matchesWindowRecord(record), { orderId });
    }
  };

  let order: OrderAttempt;
  try {
    order = await submitOrder(wallet, funding, window, side, amountUsdt, {
      onOrderSubmitted: persistSubmittedOrder,
    });
  } catch (error) {
    const message = errorText(error);
    record.status = "FAILED";
    record.skipCode = "ORDER_FAILED";
    record.error = message;

    // 钱没花出去但下单路径炸了：属于必须人工知道的事件，立即推。
    notify(
      `❌ 下单失败（不重试）\n` +
        `窗口：${tradeId}\n方向：${side}  注额：${amountUsdt}u\n原因：${message}`,
      { tradeId, side, amountUsdt, reason: message },
      { key: `order:failed:${tradeId}` },
    );

    if (recordPersisted) {
      currentState = { ...currentState, lastError: message };
      writeState(currentState);
      updateTrade(matchesWindowRecord(record), {
        status: "FAILED",
        skipCode: "ORDER_FAILED",
        error: message,
        ts: Date.now(),
        totalLossAfter: currentState.bankroll.totalLoss,
        realizedPnlAfter: currentState.realizedPnl,
      });
      logRoundSkipped(window, "ORDER_FAILED", message, {
        status: "FAILED",
        orderId: record.orderId,
      });
      return { window, openRecord: null };
    }

    return finishRecord(record, currentState, window, "ORDER_FAILED", message);
  }

  record.orderId = order.orderId ?? record.orderId;
  record.filledUsdt = order.filledUsdt;
  record.filledShares = order.filledShares;
  record.feeShares = order.feeShares;
  record.error = order.error;

  if (order.status === "FAILED") {
    record.status = "FAILED";
    record.skipCode = "ORDER_FAILED";
    record.error = order.error;
    currentState = { ...currentState, lastError: order.error };

    notify(
      `❌ 下单未成交（不重试）\n` +
        `窗口：${tradeId}\n方向：${side}  注额：${amountUsdt}u\n原因：${order.error ?? "下单失败"}`,
      { tradeId, orderId: record.orderId, side, amountUsdt, reason: order.error ?? "" },
      { key: `order:failed:${tradeId}` },
    );

    if (recordPersisted) {
      writeState(currentState);
      updateTrade(matchesWindowRecord(record), {
        status: "FAILED",
        skipCode: "ORDER_FAILED",
        orderId: record.orderId,
        filledUsdt: null,
        filledShares: null,
        feeShares: null,
        error: record.error,
        ts: Date.now(),
        totalLossAfter: currentState.bankroll.totalLoss,
        realizedPnlAfter: currentState.realizedPnl,
      });
      logRoundSkipped(window, "ORDER_FAILED", order.error ?? "下单失败", {
        status: "FAILED",
        orderId: record.orderId,
      });
      return { window, openRecord: null };
    }

    return finishRecord(
      record,
      currentState,
      window,
      "ORDER_FAILED",
      order.error ?? "下单失败",
    );
  }

  // 超时未确认 ≠ 没成交。这笔钱可能已经花了，必须让人知道要去核对。
  if (order.status === "UNKNOWN") {
    notify(
      `⚠️ 下单结果未确认，按「可能已成交」处理（不重试）\n` +
        `窗口：${tradeId}\n订单：${record.orderId || "（无 orderId）"}\n` +
        `方向：${side}  注额：${amountUsdt}u`,
      { tradeId, orderId: record.orderId, side, amountUsdt },
      { key: `order:unknown:${tradeId}` },
    );
  }

  verifyFill(record, amountUsdt, record.totalLossBefore ?? "0");

  currentState = { ...currentState, bets: currentState.bets + 1 };
  writeState(currentState);

  if (recordPersisted) {
    updateTrade(matchesWindowRecord(record), {
      status: "PENDING",
      orderId: record.orderId,
      filledUsdt: record.filledUsdt,
      filledShares: record.filledShares,
      feeShares: record.feeShares,
      avgFillPrice: record.avgFillPrice,
      fillDriftBps: record.fillDriftBps,
      winPnlIfWin: record.winPnlIfWin,
      recoveryRatio: record.recoveryRatio,
      warning: record.warning,
      error: record.error,
      ts: Date.now(),
      totalLossAfter: currentState.bankroll.totalLoss,
      realizedPnlAfter: currentState.realizedPnl,
    });
  } else {
    // 例如下单报错后从订单历史回查到已受理的单：这里补落盘。
    currentState = markWindowBet(currentState, window);
    writeState(currentState);
    appendTrade(record);
  }

  logEvent("trade_placed", {
    tradeId,
    orderId: record.orderId,
    status: order.status,
    side,
    amountUsdt,
    filledUsdt: record.filledUsdt,
    filledShares: record.filledShares,
    warning: record.warning,
  });

  return { window, openRecord: record };
}
