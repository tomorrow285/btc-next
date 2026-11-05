/** 下单路径：取单侧卖盘 → 报价 → 下单（MARKET+FOK）→ 回查终态。 */
import type { Wallet } from "../binance/accountApi.js";
import { orderBook, type OrderBook } from "../binance/marketApi.js";
import type { FundingAccount } from "./funding.js";
import {
  confirmOrder,
  findRecentOrderForMarket,
  fromWei,
  getQuote,
  placeOrder,
  toWei,
} from "../binance/tradeApi.js";
import { config } from "../config/env.js";
import type { Side } from "../domain.js";
import { tradeIdOf, type PredictionWindow } from "../market/window.js";
import { dec, decimal, type DecimalInput } from "../util/decimal.js";
import { errorText, logEvent } from "../util/log.js";
import { addMetrics } from "./metrics.js";

export interface OrderAttempt {
  status: "FILLED" | "UNKNOWN" | "FAILED";
  orderId: string | null;
  filledUsdt: string | null;
  filledShares: string | null;
  feeShares: string | null;
  error: string | null;
}

export interface SubmitOrderOptions {
  /**
   * `place-order` 返回 orderId 后立即回调。
   *
   * 调用方应在这里落 PENDING 流水并写 lastBettedWindowStart，
   * 这样即使确认终态期间进程被杀，重启后也能补结算且不会重复下注。
   */
  onOrderSubmitted?: (orderId: string) => void;
}

/** 某个方向的完整盘口（策略只需查询要买的那一侧）。 */
export async function askBook(
  window: PredictionWindow,
  side: Side,
): Promise<OrderBook> {
  const outcome = side === "UP" ? window.up : window.down;
  if (!outcome) throw new Error(`窗口没有 ${side} 方向`);
  return orderBook(window.marketId, outcome.tokenId);
}

/**
 * 下注并确认结果。
 *
 * 每窗口只尝试一次：`place-order` 一旦返回 orderId，就绝不重新报价/下单。
 * 报价或确认阶段的异常统一先回查订单历史，避免「服务端其实已受理」时重复买入。
 * orderId != 成交：必须回查订单历史到终态；查不到终态时按「可能已成交」返回 UNKNOWN。
 */
export async function submitOrder(
  wallet: Wallet,
  funding: FundingAccount,
  window: PredictionWindow,
  side: Side,
  amountUsdt: DecimalInput,
  options: SubmitOrderOptions = {},
): Promise<OrderAttempt> {
  const tradeId = tradeIdOf(window);
  const outcome = side === "UP" ? window.up : window.down;
  if (!outcome) {
    return failed(tradeId, `窗口没有 ${side} 方向`, null, amountUsdt);
  }

  const startedAt = Date.now();
  let lastOrderId: string | null = null;
  let stage: "quote" | "place" | "confirm" = "quote";

  try {
    stage = "quote";
    const quote = await getQuote({
      walletAddress: wallet.walletAddress,
      tokenId: outcome.tokenId,
      side: "BUY",
      amountInWei: toWei(amountUsdt),
      orderType: "MARKET",
      slippageBps: config.order.slippageBps,
      fundingSource: funding.fundingSource,
    });

    stage = "place";
    lastOrderId = await placeOrder({
      walletAddress: wallet.walletAddress,
      walletId: wallet.walletId,
      quoteId: quote.quoteId,
      orderType: "MARKET",
      timeInForce: "FOK",
      accountType: funding.accountType,
      slippageBps: config.order.slippageBps,
      fundingSource: funding.fundingSource,
    });

    if (!lastOrderId) throw new Error("下单接口未返回 orderId");

    // ⚠️ 在回查终态之前落盘：orderId 已经拿到，这笔单可能已经成交。
    options.onOrderSubmitted?.(lastOrderId);

    stage = "confirm";
    const confirmation = await confirmOrder(
      wallet.walletAddress,
      lastOrderId,
      config.order.confirmTimeoutMs,
    );

    if (confirmation.kind === "FILLED") {
      addMetrics({ ordersFilled: 1 });
      logEvent("order", {
        tradeId,
        status: "FILLED",
        orderId: lastOrderId,
        side,
        amountUsdt: decimal(amountUsdt),
        filledUsdt: confirmation.order.filledUsdt,
        filledShares: confirmation.order.filledShares,
        funding: funding.label,
      });
      return {
        status: "FILLED",
        orderId: lastOrderId,
        filledUsdt: confirmation.order.filledUsdt,
        filledShares: confirmation.order.filledShares,
        feeShares: fromWei(quote.feeAmountWei),
        error: null,
      };
    }

    if (confirmation.kind === "FAILED") {
      // FOK 拒绝/取消：正常没有持仓。若状态异常地带回成交份额，
      // 按「可能已成交」交给补结算，绝不标成 FAILED。
      if (dec(confirmation.order.filledShares).gt(0)) {
        addMetrics({ ordersUnknown: 1 });
        logEvent("order", {
          tradeId,
          status: "UNKNOWN",
          orderId: lastOrderId,
          side,
          amountUsdt: decimal(amountUsdt),
          orderStatus: confirmation.order.status,
          filledUsdt: confirmation.order.filledUsdt,
          filledShares: confirmation.order.filledShares,
        }, "warn");
        return {
          status: "UNKNOWN",
          orderId: lastOrderId,
          filledUsdt: confirmation.order.filledUsdt,
          filledShares: confirmation.order.filledShares,
          feeShares: fromWei(quote.feeAmountWei),
          error: `订单状态 ${confirmation.order.status} 但带有成交份额`,
        };
      }

      return failed(
        tradeId,
        `订单未成交（${confirmation.order.status}）`,
        lastOrderId,
        amountUsdt,
      );
    }

    // UNKNOWN：可能已成交，绝不重试，交给结算与补齐逻辑兜底。
    addMetrics({ ordersUnknown: 1 });
    logEvent("order", {
      tradeId,
      status: "UNKNOWN",
      orderId: lastOrderId,
      side,
      amountUsdt: decimal(amountUsdt),
      lastStatus: confirmation.lastStatus,
    });
    return {
      status: "UNKNOWN",
      orderId: lastOrderId,
      filledUsdt: null,
      filledShares: null,
      feeShares: fromWei(quote.feeAmountWei),
      error: `订单终态未确认（${confirmation.lastStatus ?? "查不到"}）`,
    };
  } catch (error) {
    const message = errorText(error);

    // 任何阶段的异常都不重试：先回查订单历史，再决定这单到底成没成。
    logEvent("order", {
      tradeId,
      status: "ERROR",
      stage,
      orderId: lastOrderId,
      error: message,
      message: "下单报错（不重试），回查订单历史",
    }, "warn");

    const found = await findRecentOrderForMarket(
      wallet.walletAddress,
      window.marketId,
      startedAt - 5_000,
    ).catch(() => null);

    if (found && found.status !== "FAILED") {
      const filled = dec(found.filledShares).gt(0);
      addMetrics(filled ? { ordersFilled: 1 } : { ordersUnknown: 1 });
      logEvent("order", {
        tradeId,
        status: filled ? "FILLED" : "UNKNOWN",
        recoveredFromHistory: true,
        orderId: found.orderId,
        orderStatus: found.status,
        filledUsdt: found.filledUsdt,
        filledShares: found.filledShares,
      });
      return {
        status: filled ? "FILLED" : "UNKNOWN",
        orderId: found.orderId,
        filledUsdt: found.filledUsdt,
        filledShares: found.filledShares,
        feeShares: null,
        error: null,
      };
    }

    // 已经拿到 orderId 却查不到终态：可能已成交，不能当失败丢掉。
    if (lastOrderId) {
      addMetrics({ ordersUnknown: 1 });
      logEvent("order", {
        tradeId,
        status: "UNKNOWN",
        orderId: lastOrderId,
        error: message,
      });
      return {
        status: "UNKNOWN",
        orderId: lastOrderId,
        filledUsdt: null,
        filledShares: null,
        feeShares: null,
        error: message,
      };
    }

    return failed(tradeId, message, null, amountUsdt);
  }
}

function failed(
  tradeId: string,
  message: string,
  orderId: string | null,
  amountUsdt: DecimalInput,
): OrderAttempt {
  addMetrics({ ordersFailed: 1 });
  logEvent("order", {
    tradeId,
    status: "FAILED",
    orderId,
    amountUsdt: decimal(amountUsdt),
    error: message,
  }, "error");
  return {
    status: "FAILED",
    orderId,
    filledUsdt: null,
    filledShares: null,
    feeShares: null,
    error: message,
  };
}
