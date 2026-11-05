/** 预测盘公开接口：市场列表、窗口详情、盘口深度。全部免登录、免签名。 */
import { config } from "../config/env.js";
import { decimal, decimalOrNull } from "../util/decimal.js";
import { publicPost } from "./http.js";

export interface TimelineEntry {
  marketTopicId: number;
  startDate: number;
  endDate: number;
}

export interface MarketTopic {
  marketTopicId: number;
  slug: string;
  eventSlug: string;
  title: string;
}

export interface Outcome {
  name: string;
  tokenId: string;
  /** 份额参考价（0~1，十进制字符串）。只作展示；成交成本按卖一价算。 */
  price: string;
  chance: number;
  /** 只有结算后才有值；平局时可能两个 outcome 同时为 true。 */
  winner: boolean | null;
}

export interface Market {
  marketId: number;
  /** 只有 OPEN 才允许下单。 */
  tradingStatus: string;
  settled: boolean;
  outcomes: Outcome[];
  tradeVolume: number;
  liquidity: number;
}

export interface MarketDetail {
  startDate: number;
  endDate: number;
  /** startPrice 只在开盘那一刻写入，开盘前为 null；endPrice 在收盘后写入。 */
  variantData: { startPrice: string | null; endPrice: string | null };
  markets: Market[];
  /** 覆盖未来约 12.5 小时，是拿窗口 marketTopicId 的入口。 */
  timeline: TimelineEntry[];
  participantCount: number;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  /** 快照时间。明显落后于当前时间 = 冻结快照。 */
  timestamp: number;
}

// ---------- 原始响应（数字/可选字段） ----------

interface RawOutcome {
  name?: string;
  tokenId?: string;
  price?: number;
  chance?: number;
  winner?: boolean | null;
}

interface RawMarket {
  marketId?: number;
  tradingStatus?: string;
  settled?: boolean;
  outcomes?: RawOutcome[];
  tradeVolume?: number;
  liquidity?: number;
}

interface RawMarketDetail {
  startDate?: number;
  endDate?: number;
  variantData?: { startPrice?: number | null; endPrice?: number | null };
  markets?: RawMarket[];
  timeline?: TimelineEntry[];
  participantCount?: number;
}

interface RawOrderBookLevel {
  price?: number;
  size?: number;
}

interface RawOrderBook {
  bids?: RawOrderBookLevel[];
  asks?: RawOrderBookLevel[];
  timestamp?: number;
}

function mapOutcome(outcome: RawOutcome): Outcome {
  return {
    name: outcome.name ?? "",
    tokenId: outcome.tokenId ?? "",
    price: decimal(outcome.price ?? 0),
    chance: Number(outcome.chance ?? 0),
    winner: outcome.winner ?? null,
  };
}

function mapMarket(market: RawMarket): Market {
  return {
    marketId: Number(market.marketId ?? 0),
    tradingStatus: market.tradingStatus ?? "",
    settled: market.settled ?? false,
    outcomes: (market.outcomes ?? []).map(mapOutcome),
    tradeVolume: Number(market.tradeVolume ?? 0),
    liquidity: Number(market.liquidity ?? 0),
  };
}

function mapLevel(level: RawOrderBookLevel): OrderBookLevel {
  return {
    price: decimal(level.price ?? 0),
    size: decimal(level.size ?? 0),
  };
}

export async function listMarketTopics(
  limit: number,
  offset: number,
): Promise<MarketTopic[]> {
  const data = await publicPost<{ marketTopics: MarketTopic[] }>("market/list", {
    limit,
    offset,
  });
  return data.marketTopics ?? [];
}

export async function marketDetail(marketTopicId: number): Promise<MarketDetail> {
  const data = await publicPost<RawMarketDetail>("market/detail", { marketTopicId });
  return {
    startDate: Number(data.startDate ?? 0),
    endDate: Number(data.endDate ?? 0),
    variantData: {
      startPrice: decimalOrNull(data.variantData?.startPrice),
      endPrice: decimalOrNull(data.variantData?.endPrice),
    },
    markets: (data.markets ?? []).map(mapMarket),
    timeline: data.timeline ?? [],
    participantCount: Number(data.participantCount ?? 0),
  };
}

export async function orderBook(marketId: number, tokenId: string): Promise<OrderBook> {
  const data = await publicPost<RawOrderBook>("order-book", {
    marketId,
    tokenId,
    vendor: config.prediction.vendor,
  });
  return {
    bids: (data.bids ?? []).map(mapLevel),
    asks: (data.asks ?? []).map(mapLevel),
    timestamp: Number(data.timestamp ?? 0),
  };
}
