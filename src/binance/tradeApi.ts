/**
 * 预测盘交易接口（签名）：报价、下单、订单回查。
 *
 * 固定两步：先 get-quote 拿 quoteId，再用 quoteId 下单。
 * 下单响应只有 orderId、没有状态，必须回查 order/history 到终态。
 *
 * 出资账户在 run 启动时选定一次（见 engine/funding.ts），这里只接收结果。
 */
import { sleep } from "../util/async.js";
import { BigNumber, dec, decimal, type DecimalInput } from "../util/decimal.js";
import { signedRequest } from "./http.js";

const PREDICTION_PATH = "/sapi/v1/w3w/wallet/prediction";

export type OrderSide = "BUY";
export type QuoteOrderType = "MARKET";
export type PlaceOrderType = "MARKET";
export type TimeInForce = "FOK" | "GTC";
/** MPC = 预测钱包；CEX = 币安现货/资金账户。 */
export type FundingSource = "MPC" | "CEX";
export type AccountType = "SPOT" | "FUNDING";

// ---------- 金额换算 ----------

const WEI_DECIMALS = 18;
const USDT_DECIMALS = 6;
const WEI_PER_USDT = dec(10).pow(WEI_DECIMALS);

/** USDT 金额 → wei 字符串（18 位小数），只保留到微 USDT。 */
export function toWei(usdt: DecimalInput): string {
  const micro = dec(usdt)
    .times(dec(10).pow(USDT_DECIMALS))
    .integerValue(BigNumber.ROUND_HALF_UP);

  if (!micro.gt(0)) throw new Error(`金额不合法：${usdt}`);
  return micro.times(dec(10).pow(WEI_DECIMALS - USDT_DECIMALS)).toFixed(0);
}

/** wei 字符串 → USDT（十进制字符串）。 */
export function fromWei(wei: string): string {
  return dec(wei).div(WEI_PER_USDT).toFixed();
}

// ---------- 报价 ----------

export interface QuoteParams {
  walletAddress: string;
  tokenId: string;
  side: OrderSide;
  /** 买入时是花费的 USDT */
  amountInWei: string;
  orderType: QuoteOrderType;
  slippageBps: number;
  fundingSource?: FundingSource;
}

export interface Quote {
  quoteId: string;
  marketTitle: string;
  /** 预估成交均价（份额价 0~1，十进制字符串） */
  averagePrice: string;
  lastPrice: string;
  priceImpact: string;
  amountInWei: string;
  /** 扣费前的毛份额（wei 字符串） */
  amountOutWei: string;
  /** 手续费（份额，wei 字符串） */
  feeAmountWei: string;
  chance: string;
}

export async function getQuote(params: QuoteParams): Promise<Quote> {
  const request = {
    walletAddress: params.walletAddress,
    tokenId: params.tokenId,
    side: params.side,
    amountIn: params.amountInWei,
    orderType: params.orderType,
    slippageBps: params.slippageBps,
    ...(params.fundingSource ? { fundingSource: params.fundingSource } : {}),
  };

  const data = await signedRequest<{
    quoteId?: string;
    marketTitle?: string;
    averagePrice?: number;
    lastPrice?: number;
    priceImpact?: number;
    amountIn?: string;
    amountOut?: string;
    feeAmount?: string;
    chance?: string;
  }>("POST", `${PREDICTION_PATH}/trade/get-quote`, request);

  return {
    quoteId: data.quoteId ?? "",
    marketTitle: data.marketTitle ?? "",
    averagePrice: decimal(data.averagePrice ?? 0),
    lastPrice: decimal(data.lastPrice ?? 0),
    priceImpact: decimal(data.priceImpact ?? 0),
    amountInWei: data.amountIn ?? "0",
    amountOutWei: data.amountOut ?? "0",
    feeAmountWei: data.feeAmount ?? "0",
    chance: data.chance ?? "",
  };
}

// ---------- 下单 ----------

export interface PlaceParams {
  walletAddress: string;
  walletId: string;
  quoteId: string;
  orderType: PlaceOrderType;
  /** MARKET 必须 FOK；LIMIT 必须 GTC。 */
  timeInForce: TimeInForce;
  accountType: AccountType;
  slippageBps: number;
  priceLimit?: string;
  fundingSource?: FundingSource;
}

/**
 * 真实下单。这个函数会动钱。
 *
 * ⚠️ 传输层重试必须为 0：网络超时那类错误服务端可能已经受理，重试就是重复下单。
 * 「到底成没成」交给 confirmOrder 回查订单历史。
 */
export async function placeOrder(params: PlaceParams): Promise<string> {
  const request = {
    walletAddress: params.walletAddress,
    walletId: params.walletId,
    quoteId: params.quoteId,
    timeInForce: params.timeInForce,
    accountType: params.accountType,
    orderType: params.orderType,
    slippageBps: params.slippageBps,
    ...(params.priceLimit ? { priceLimit: params.priceLimit } : {}),
    ...(params.fundingSource ? { fundingSource: params.fundingSource } : {}),
  };

  const data = await signedRequest<{ orderId?: string }>(
    "POST",
    `${PREDICTION_PATH}/trade/place-order-bundle`,
    request,
    { retry: 0 },
  );
  return data.orderId ?? "";
}

// ---------- 订单查询 ----------

/** 这些状态都表示「这单没成交」。FILLED 之外的其余状态按「还在撮合」处理。 */
export const UNFILLED_STATUS = new Set([
  "FAILED",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
]);

export interface OrderRecord {
  orderId: string;
  marketId: number;
  status: string;
  /** 已成交金额 / 份额（十进制字符串） */
  filledUsdt: string;
  filledShares: string;
  createTime: number;
}

interface RawOrder {
  orderId?: string;
  marketId?: number;
  status?: string;
  filledUsdtAmount?: string;
  filledShareQty?: string;
  createTime?: number;
}

function toOrderRecord(order: RawOrder): OrderRecord {
  return {
    orderId: String(order.orderId ?? ""),
    marketId: Number(order.marketId ?? 0),
    status: String(order.status ?? ""),
    filledUsdt: decimal(order.filledUsdtAmount ?? 0),
    filledShares: decimal(order.filledShareQty ?? 0),
    createTime: Number(order.createTime ?? 0),
  };
}

async function orderHistory(walletAddress: string, limit: number): Promise<OrderRecord[]> {
  const data = await signedRequest<{ orders?: RawOrder[] }>(
    "GET",
    `${PREDICTION_PATH}/order/history`,
    { walletAddress, limit },
  );
  return (data.orders ?? []).map(toOrderRecord);
}

/**
 * 按 orderId 精确找一笔。
 *
 * 重试后同一个 marketId 上会有多笔单，只有 orderId 唯一；按 marketId 找会拿到废单。
 * limit 放到 50：补结算可能发生在几小时后，20 条窗口会把早期订单挤出去。
 */
export async function findOrderById(
  walletAddress: string,
  orderId: string,
  limit = 50,
): Promise<OrderRecord | null> {
  const orders = await orderHistory(walletAddress, limit);
  return orders.find((order) => order.orderId === orderId) ?? null;
}

/**
 * 回查某个 marketId 上最近有没有真的下出单子。
 * 用于「下单报错 ≠ 没下单」的场景，宁可按已成交处理。
 */
export async function findRecentOrderForMarket(
  walletAddress: string,
  marketId: number,
  sinceMs: number,
): Promise<OrderRecord | null> {
  const orders = await orderHistory(walletAddress, 20);
  return (
    orders.find((order) => order.marketId === marketId && order.createTime >= sinceMs) ?? null
  );
}

export interface ActiveOrder {
  orderId: string;
  marketId: number;
  marketTitle: string;
  outcome: string;
  side: string;
  orderType: string;
  status: string;
  fillPercentage: string;
  price: string;
  createTime: number;
}

export async function listActiveOrders(walletAddress: string): Promise<ActiveOrder[]> {
  const data = await signedRequest<{
    orders?: Array<{
      orderId?: string;
      marketId?: number;
      marketTitle?: string;
      outcome?: string;
      side?: string;
      orderType?: string;
      status?: string;
      fillPercentage?: string;
      price?: string;
      createTime?: number;
    }>;
  }>("GET", `${PREDICTION_PATH}/order/list`, { walletAddress });

  return (data.orders ?? []).map((order) => ({
    orderId: String(order.orderId ?? ""),
    marketId: Number(order.marketId ?? 0),
    marketTitle: String(order.marketTitle ?? ""),
    outcome: String(order.outcome ?? ""),
    side: String(order.side ?? ""),
    orderType: String(order.orderType ?? ""),
    status: String(order.status ?? ""),
    fillPercentage: String(order.fillPercentage ?? "0"),
    price: String(order.price ?? "0"),
    createTime: Number(order.createTime ?? 0),
  }));
}

// ---------- 终态确认 ----------

export type OrderConfirmation =
  | { kind: "FILLED"; order: OrderRecord }
  | { kind: "FAILED"; order: OrderRecord }
  | { kind: "UNKNOWN"; lastStatus: string | null };

/**
 * 下单之后确认这单真的成交了。
 *
 * 终态是异步落下来的（实测成交 1~4s，被拒最慢 14s）。
 * ⚠️ 超时未终态 ≠ 失败，调用方必须按「可能已成交」处理。
 */
export async function confirmOrder(
  walletAddress: string,
  orderId: string,
  timeoutMs: number,
): Promise<OrderConfirmation> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | null = null;

  for (;;) {
    const order = await findOrderById(walletAddress, orderId);
    if (order) {
      lastStatus = order.status;
      if (order.status === "FILLED") return { kind: "FILLED", order };
      if (UNFILLED_STATUS.has(order.status)) return { kind: "FAILED", order };
    }
    if (Date.now() >= deadline) return { kind: "UNKNOWN", lastStatus };
    await sleep(700);
  }
}
