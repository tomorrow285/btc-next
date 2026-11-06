/**
 * 按**盘口深度**算可成交均价与注额（纯计算）。
 *
 * 卖一价只代表第一档能吃到的价格，大注会吃穿好几档。这里：
 *   1. 先按基础注码算一次可成交均价（VWAP），作为有效倍率门槛的口径；
 *   2. 解 **不动点**：注额越大 → 吃穿档位越多 → 可成交均价越高 → 倍率越低 → 需要的注额更大。
 *      所以在盘口上二分求「让 `赢时收益 ≥ 欠账` 成立的最小注额」，而不是拿基础注码那一档的
 *      均价一次算完（那样会**系统性偏小**，赢了也补不平）；
 *   3. 最后按注额逐档吃单复核深度。吃不下就标记 `depthShortfall`，
 *      由调用方 warn + notify，但**不拦截下单**（FOK 自己会决定成不成）。
 */
import { dec, maxDecimal, type BigNumber, type DecimalInput } from "../util/decimal.js";
import { isConservative, stakeAmount, type Bankroll, type MartingaleSettings } from "./money.js";

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
  /** 解补亏时假设的成交价（= execPrice × (1 + 滑点假设)），用于日志核对 */
  assumedFillPrice: string;
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
 * 花掉 `amount` 逐档吃单后，**若本局赢**能赚多少：`amount × ((1 − fee) / fillPrice − 1)`。
 * 与 `money.pnlFromFill` 的「份数 × 1 − 实扣」同一口径。吃不下（超出容量）返回 null。
 *
 * `driftBps` 是**成交价相对盘口均价的保守假设**：盘口快照 → 交易所成交之间会滑点，
 * 实测中位 +196bps（46 笔）。补亏按「好价钱」算会系统性补不平，所以默认按更差的价算收益。
 */
function winPnlOf(
  levels: readonly PriceLevel[],
  amount: BigNumber,
  feeRate: DecimalInput,
  driftBps = 0,
): BigNumber | null {
  if (!amount.gt(0)) return dec(0);
  const vwap = vwapForAmount(levels, amount.toFixed());
  if (vwap === null) return null;
  const fillPrice = dec(vwap).times(dec(1).plus(dec(driftBps).div(10_000)));
  if (!fillPrice.gt(0)) return null;
  return amount.times(dec(1).minus(feeRate).div(fillPrice).minus(1));
}

/**
 * 在盘口上解「赢时收益 ≥ want」的**最小**注额（不动点）。
 *
 * 为什么能二分：每多花 1 USDT 买在 `p < 1 − fee` 的档位上，赢时的边际收益
 * `(1 − fee)/p − 1 > 0`，所以 `winPnl(A)` 对 A 严格递增。
 *
 * 返回 null = 把盘口吃光也补不平，交给调用方按 `depthShortfall` 处理。
 */
function solveRecovery(
  levels: readonly PriceLevel[],
  want: BigNumber,
  capacity: BigNumber,
  feeRate: DecimalInput,
  driftBps = 0,
): BigNumber | null {
  if (!want.gt(0)) return dec(0);
  const atCapacity = winPnlOf(levels, capacity, feeRate, driftBps);
  if (atCapacity === null || atCapacity.lt(want)) return null;

  let lo = dec(0);
  let hi = capacity;
  for (let i = 0; i < 64; i++) {
    const mid = lo.plus(hi).div(2);
    const win = winPnlOf(levels, mid, feeRate, driftBps);
    if (win === null || win.lt(want)) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * 用盘口深度推算本轮注额与可成交均价。
 *
 * ⚠️ 注额必须按「**这个注额自己**吃出来的均价」解，不能拿基础注码 1u 的均价一次算完：
 * 大注会吃穿好几档、均价更高、倍率更低，一次算完的注额会系统性偏小，赢了补不平欠账
 * （2026-11-01 21:15 事故里 113.72u 按 0.76 算、0.9088 成交，补回率只有 35%）。
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

  const debt = dec(bankroll.totalLoss);
  const driftBps = settings.fillPriceDriftBps ?? 0;
  let amount: BigNumber;

  if (!debt.gt(0)) {
    // 没有欠账：就是基础注码，不需要解不动点。
    amount = basePrice;
  } else {
    const recovery = solveRecovery(levels, debt, capacity, settings.feeRate, driftBps);
    if (recovery === null) {
      // 盘口吃光也补不平：退回「按容量均价估算」的旧口径，给一个偏大的注额，
      // 交给下面的 depthShortfall 分支（告警 + 仍下单，让 FOK 自己决定成不成）。
      const vwapCapacity = vwapForAmount(levels, capacity.toFixed()) ?? baseExecPrice;
      amount = dec(
        stakeAmount(bankroll, settings, dec(1).div(vwapCapacity).toFixed()),
      );
    } else {
      // 与 money.stakeAmount 同口径：保守模式只补亏，常规模式再加一个基础注码。
      // 区别只在于 recovery 是按「吃到那么深」的均价解出来的。
      amount = maxDecimal(
        isConservative(bankroll, settings) ? recovery : basePrice.plus(recovery),
        basePrice,
      );
    }
  }

  const execPrice = vwapForAmount(levels, amount.toFixed());
  const assumedFill = (price: string): string =>
    dec(price).times(dec(1).plus(dec(driftBps).div(10_000))).toFixed();

  if (execPrice === null) {
    const execAtCapacity =
      vwapForAmount(levels, capacity.toFixed()) ?? baseExecPrice;
    return {
      amountUsdt: amount.toFixed(),
      execPrice: execAtCapacity,
      baseExecPrice,
      capacityUsdt: capacity.toFixed(),
      depthShortfall: true,
      assumedFillPrice: assumedFill(execAtCapacity),
    };
  }

  return {
    amountUsdt: amount.toFixed(),
    execPrice,
    baseExecPrice,
    capacityUsdt: capacity.toFixed(),
    depthShortfall: false,
    assumedFillPrice: assumedFill(execPrice),
  };
}
