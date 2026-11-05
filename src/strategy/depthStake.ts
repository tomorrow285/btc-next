/**
 * 按**盘口深度**算可成交均价与注额（纯计算）。
 *
 * 卖一价只代表第一档能吃到的价格，大注会吃穿好几档。这里：
 *   1. 先按基础注码算一次可成交均价（VWAP），作为有效倍率门槛的口径；
 *   2. 再用该均价代入马丁格尔公式推算本轮注额；
 *   3. 最后按注额逐档吃单复核深度。吃不下就标记 `depthShortfall`，
 *      由调用方 warn + notify，但**不拦截下单**（FOK 自己会决定成不成）。
 */
import { dec, type BigNumber, type DecimalInput } from "../util/decimal.js";
import { stakeAmount, type Bankroll, type MartingaleSettings } from "./money.js";

/** 盘口档位。与 `binance/marketApi.ts` 的 `OrderBookLevel` 结构兼容。 */
export interface PriceLevel {
  price: string;
  size: string;
}

export interface DepthPlan {
  /** 本轮计划下注额（USDT，十进制字符串） */
  amountUsdt: string;
  /** 按计划注额逐档吃单后的可成交均价；深度不足时是吃满容量后的均价 */
  execPrice: string;
  /** 按基础注码算出的可成交均价，用于有效倍率门槛 */
  baseExecPrice: string;
  /** 价格 < 1 − feeRate 的所有档位能吃下的 USDT 总量 */
  capacityUsdt: string;
  /** 盘口深度接不下计划注额（仍然下单） */
  depthShortfall: boolean;
}

const byPriceAsc = (left: PriceLevel, right: PriceLevel): number =>
  dec(left.price).comparedTo(dec(right.price)) ?? 0;

/**
 * 可成交档位：价格 > 0、数量 > 0、且价格 < 1 − feeRate（扣费后有效倍率 > 1）。
 * 返回按价格升序排列的副本，不修改入参。
 */
export function tradableAsks(
  asks: readonly PriceLevel[],
  feeRate: DecimalInput,
): PriceLevel[] {
  const maxPrice = dec(1).minus(feeRate);
  return asks
    .filter((level) => {
      const price = dec(level.price);
      return price.gt(0) && dec(level.size).gt(0) && price.lt(maxPrice);
    })
    .slice()
    .sort(byPriceAsc);
}

function capacityOf(levels: readonly PriceLevel[]): BigNumber {
  return levels.reduce(
    (sum, level) => sum.plus(dec(level.price).times(dec(level.size))),
    dec(0),
  );
}

/** 可成交档位能吃下的 USDT 总量（十进制字符串）。 */
export function askCapacity(
  asks: readonly PriceLevel[],
  feeRate: DecimalInput,
): string {
  return capacityOf(tradableAsks(asks, feeRate)).toFixed();
}

/**
 * 按金额逐档吃单，算加权均价。
 *
 * `levels` 必须是已按价格升序过滤好的可成交档位（`tradableAsks` 的返回值）。
 * 深度不够（吃完全部档位仍有剩余）返回 null。
 */
export function vwapForAmount(
  levels: readonly PriceLevel[],
  amountUsdt: DecimalInput,
): string | null {
  let left = dec(amountUsdt);
  if (!left.gt(0)) return null;

  let shares = dec(0);
  let spent = dec(0);

  for (const level of levels) {
    const price = dec(level.price);
    const size = dec(level.size);
    const cost = price.times(size);

    if (cost.lte(left)) {
      left = left.minus(cost);
      shares = shares.plus(size);
      spent = spent.plus(cost);
    } else {
      shares = shares.plus(left.div(price));
      spent = spent.plus(left);
      left = dec(0);
      break;
    }
  }

  if (left.gt(0) || !shares.gt(0)) return null;
  return spent.div(shares).toFixed();
}

/**
 * 用盘口深度推算本轮注额与可成交均价。
 *
 * 返回 null 表示连基础注码都接不下（没有可成交档位）。
 * 注额超出容量时返回 `depthShortfall = true`，不返回 null —— 由调用方决定
 * 只告警还是继续下单（重构后的口径是继续下单）。
 */
export function planStakeByDepth(
  asks: readonly PriceLevel[],
  bankroll: Bankroll,
  settings: MartingaleSettings,
): DepthPlan | null {
  const levels = tradableAsks(asks, settings.feeRate);
  const capacity = capacityOf(levels);
  if (!capacity.gt(0)) return null;

  const basePrice = dec(settings.basePrice);
  const baseExecPrice = vwapForAmount(levels, basePrice.toFixed());
  if (baseExecPrice === null) return null;

  const quotedMultiple = dec(1).div(baseExecPrice).toFixed();
  const amount = dec(stakeAmount(bankroll, settings, quotedMultiple));
  const execPrice = vwapForAmount(levels, amount.toFixed());

  if (execPrice === null) {
    const execAtCapacity =
      vwapForAmount(levels, capacity.toFixed()) ?? baseExecPrice;
    return {
      amountUsdt: amount.toFixed(),
      execPrice: execAtCapacity,
      baseExecPrice,
      capacityUsdt: capacity.toFixed(),
      depthShortfall: true,
    };
  }

  return {
    amountUsdt: amount.toFixed(),
    execPrice,
    baseExecPrice,
    capacityUsdt: capacity.toFixed(),
    depthShortfall: false,
  };
}
