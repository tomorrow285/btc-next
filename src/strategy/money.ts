/**
 * 马丁格尔资金管理（纯计算）：注码、盈亏、重新初始化判据。
 *
 * 所有金额与倍率都用 bignumber.js 计算。
 *
 * 倍率口径：
 *   报价倍率 = 1 / 可成交均价
 *   有效倍率 = 报价倍率 × (1 − 手续费率)
 */
import {
  dec,
  maxDecimal,
  type BigNumber,
  type DecimalInput,
} from "../util/decimal.js";

export interface Bankroll {
  /** 历史亏损合计，恒 >= 0，十进制字符串。 */
  totalLoss: string;
  /** 连败次数，赢一次归零。 */
  lossStreak: number;
}

export interface MartingaleSettings {
  basePrice: number;
  feeRate: number;
  riskAmount: number;
  riskCount: number;
  resetLossStreak: number;
  resetLossMultiple: number;
  /**
   * 解补亏时假设的成交价滑点（bps，相对盘口均价）。
   * 盘口快照 → 交易所成交之间实测中位 +196bps，按 0 算会系统性补不平。
   */
  fillPriceDriftBps?: number;
}

export function emptyBankroll(): Bankroll {
  return { totalLoss: "0", lossStreak: 0 };
}

export function effectiveMultiplier(
  quotedMultiple: DecimalInput,
  feeRate: DecimalInput,
): BigNumber {
  return dec(quotedMultiple).times(dec(1).minus(feeRate));
}

/** 有效倍率必须 >= 最小门槛才允许下单。 */
export function canBet(
  quotedMultiple: DecimalInput,
  feeRate: DecimalInput,
  minEffectiveMultiplier: DecimalInput,
): boolean {
  const effective = effectiveMultiplier(quotedMultiple, feeRate);
  return effective.isFinite() && effective.gte(minEffectiveMultiplier);
}

/**
 * 下一注金额（USDT，十进制字符串）。
 *
 *   常规：B0_BASE_PRICE + TOTAL_LOSS / (有效倍率 − 1)
 *   保守：TOTAL_LOSS / (有效倍率 − 1)，当连败或欠账触发阈值
 *
 * 下限是基础注码：市场有最小下单额，且保守模式在极高赔率下会算出很小的值。
 */
export function stakeAmount(
  bankroll: Bankroll,
  settings: MartingaleSettings,
  quotedMultiple: DecimalInput,
): string {
  const effective = effectiveMultiplier(quotedMultiple, settings.feeRate);
  if (!effective.gt(1)) {
    throw new Error(`有效倍率 ${effective.toFixed(4)} <= 1，补亏公式无解`);
  }

  const basePrice = dec(settings.basePrice);
  const totalLoss = dec(bankroll.totalLoss);
  const recovery = totalLoss.div(effective.minus(1));
  const raw = isConservative(bankroll, settings)
    ? recovery
    : basePrice.plus(recovery);

  return maxDecimal(raw, basePrice).toFixed();
}

/**
 * 本轮是否「保守模式」：只求抹平、不额外赚基础注码的那份利润。
 * 触发条件：有欠账，且连败 >= RISK_COUNT 或 TOTAL_LOSS >= RISK_AMOUNT。
 */
export function isConservative(
  bankroll: Bankroll,
  settings: MartingaleSettings,
): boolean {
  const totalLoss = dec(bankroll.totalLoss);
  return (
    totalLoss.gt(0) &&
    (bankroll.lossStreak >= settings.riskCount ||
      totalLoss.gte(settings.riskAmount))
  );
}

/** 用本回合实际盈亏更新欠账与连败。 */
export function settleBankroll(bankroll: Bankroll, pnl: DecimalInput): Bankroll {
  const value = dec(pnl);

  if (value.lt(0)) {
    return {
      totalLoss: dec(bankroll.totalLoss).plus(value.abs()).toFixed(),
      lossStreak: bankroll.lossStreak + 1,
    };
  }

  if (value.gt(0)) {
    return {
      totalLoss: maxDecimal(0, dec(bankroll.totalLoss).minus(value)).toFixed(),
      lossStreak: 0,
    };
  }

  return bankroll;
}

export function resetLossThreshold(settings: MartingaleSettings): string {
  return dec(settings.basePrice).times(settings.resetLossMultiple).toFixed();
}

/**
 * 是否需要「重新初始化」。
 * 任一满足即触发：连败 >= 阈值，或 TOTAL_LOSS >= 基础注码 × 倍数。
 */
export function resetReason(
  bankroll: Bankroll,
  settings: MartingaleSettings,
): string | null {
  if (bankroll.lossStreak >= settings.resetLossStreak) {
    return `连败 ${bankroll.lossStreak} >= ${settings.resetLossStreak}`;
  }

  const totalLoss = dec(bankroll.totalLoss);
  const threshold = dec(resetLossThreshold(settings));
  if (totalLoss.gte(threshold)) {
    return (
      `TOTAL_LOSS ${totalLoss.toFixed(4)} >= ${threshold.toFixed()}` +
      `（基础注码 ${settings.basePrice} × ${settings.resetLossMultiple}）`
    );
  }
  return null;
}

/** 由真实成交明细算回合盈亏。 */
export function pnlFromFill(
  filledShares: DecimalInput,
  filledUsdt: DecimalInput,
  payout: DecimalInput,
): string {
  return dec(filledShares).times(payout).minus(filledUsdt).toFixed();
}

export function resultLabel(pnl: DecimalInput): "赢" | "输" | "平" {
  const value = dec(pnl);
  if (value.gt(0)) return "赢";
  if (value.lt(0)) return "输";
  return "平";
}
