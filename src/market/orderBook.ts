/**
 * 盘口工具（十进制运算）。
 *
 * 预测盘以「份额」计价：1 份中奖结算 1 USDT，价格 0~1 即隐含概率。
 * 买某方向 = 吃掉该方向的卖单（asks），所以成交成本看卖一价。
 */
import type { OrderBook } from "../binance/marketApi.js";
import { dec } from "../util/decimal.js";

const byPriceAsc = (
  left: { price: string },
  right: { price: string },
): number => dec(left.price).comparedTo(dec(right.price)) ?? 0;

const byPriceDesc = (
  left: { price: string },
  right: { price: string },
): number => dec(right.price).comparedTo(dec(left.price)) ?? 0;

/** 卖一价（买入成本）。没有卖单时返回 null。 */
export function bestAsk(book: OrderBook): string | null {
  const asks = [...(book.asks ?? [])].sort(byPriceAsc);
  const price = asks[0]?.price;
  return price !== undefined && dec(price).gt(0) ? price : null;
}

/** 买一价（卖出时能拿到的价）。 */
export function bestBid(book: OrderBook): string | null {
  const bids = [...(book.bids ?? [])].sort(byPriceDesc);
  const price = bids[0]?.price;
  return price !== undefined && dec(price).gt(0) ? price : null;
}

export interface FillEstimate {
  shares: string;
  avgPrice: string;
  worstPrice: string | null;
  /** 预算是否被吃光。false = 盘口深度不够。 */
  filled: boolean;
}

export interface Depth {
  bestBid: string | null;
  bestAsk: string | null;
  spread: string | null;
  askLevels: number;
  /** 卖一价 +2% 之内能塞进去的 USDT */
  usdt2pct: string;
  /** 卖一价 +5% 之内能塞进去的 USDT */
  usdt5pct: string;
  fill100: FillEstimate;
  fill500: FillEstimate;
  /** 盘口快照滞后秒数；越大越可能是冻结快照。 */
  lagSec: number;
}

/** 把盘口换算成「这个方向能吃多大资金量」。仅用于看板与人工判断。 */
export function depthOf(book: OrderBook, now: number = Date.now()): Depth {
  const asks = [...(book.asks ?? [])].sort(byPriceAsc);
  const askPrice = bestAsk(book);
  const bidPrice = bestBid(book);

  const within = (slippage: number): string => {
    if (askPrice === null) return "0";
    const cap = dec(askPrice).times(dec(1).plus(slippage));
    let sum = dec(0);
    for (const level of asks) {
      const price = dec(level.price);
      if (price.gt(cap)) break;
      sum = sum.plus(price.times(dec(level.size)));
    }
    return sum.toFixed();
  };

  const fill = (budget: string): FillEstimate => {
    let left = dec(budget);
    let shares = dec(0);
    let spent = dec(0);
    let worst: string | null = null;

    for (const level of asks) {
      const price = dec(level.price);
      const size = dec(level.size);
      const cost = price.times(size);

      if (cost.lte(left)) {
        left = left.minus(cost);
        shares = shares.plus(size);
        spent = spent.plus(cost);
        worst = price.toFixed();
      } else {
        const sizeTaken = left.div(price);
        shares = shares.plus(sizeTaken);
        spent = spent.plus(left);
        worst = price.toFixed();
        left = dec(0);
        break;
      }
    }

    return {
      shares: shares.toFixed(),
      avgPrice: shares.gt(0) ? spent.div(shares).toFixed() : "0",
      worstPrice: worst,
      filled: left.lte(0),
    };
  };

  return {
    bestBid: bidPrice,
    bestAsk: askPrice,
    spread:
      askPrice !== null && bidPrice !== null
        ? dec(askPrice).minus(bidPrice).toFixed()
        : null,
    askLevels: asks.length,
    usdt2pct: within(0.02),
    usdt5pct: within(0.05),
    fill100: fill("100"),
    fill500: fill("500"),
    lagSec: Number.isFinite(book.timestamp)
      ? Math.max(0, (now - book.timestamp) / 1000)
      : Number.NaN,
  };
}
