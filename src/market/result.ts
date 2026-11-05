/** 窗口结果判定与派彩口径（纯函数，全部走十进制运算）。 */
import type { Side, WindowOutcome } from "../domain.js";
import { decOrNull, type DecimalInput } from "../util/decimal.js";

export interface WindowJudgement {
  outcome: WindowOutcome;
  openPrice: string;
  endPrice: string;
  /** 涨跌幅（%）。正数 = 上涨。 */
  changePct: string;
}

/**
 * 用官方盘面的开盘价/到期价比大小，推出获胜方向。
 * 任一价格缺失或非法 → null，让调用方去等，绝不在这里猜。
 */
export function judgeByPrice(
  startPrice: DecimalInput | null,
  endPrice: DecimalInput | null,
): WindowOutcome | null {
  const start = decOrNull(startPrice);
  const end = decOrNull(endPrice);
  if (start === null || end === null) return null;

  if (end.gt(start)) return "UP";
  if (end.lt(start)) return "DOWN";
  return "DRAW";
}

/** 涨跌幅（%）。开盘价非正时返回 null。 */
export function changePctOf(
  startPrice: DecimalInput | null,
  endPrice: DecimalInput | null,
): string | null {
  const start = decOrNull(startPrice);
  const end = decOrNull(endPrice);
  if (start === null || end === null || start.lte(0)) return null;

  return end.minus(start).div(start).times(100).toFixed();
}

/** 两个价格都就绪时，一次性给出完整判定。 */
export function judgeWindowPrices(
  startPrice: DecimalInput | null,
  endPrice: DecimalInput | null,
): WindowJudgement | null {
  const start = decOrNull(startPrice);
  const end = decOrNull(endPrice);
  const outcome = judgeByPrice(startPrice, endPrice);
  const changePct = changePctOf(startPrice, endPrice);
  if (outcome === null || changePct === null || start === null || end === null) {
    return null;
  }

  return {
    outcome,
    openPrice: start.toFixed(),
    endPrice: end.toFixed(),
    changePct,
  };
}

/**
 * 每份派彩：买对 1，买错 0，平局 0.5。
 * 平局时不论押哪个方向都派 0.5 —— 这就是官方「50-50 结算」。
 */
export function payoutPerShare(side: Side, outcome: WindowOutcome): string {
  if (outcome === "DRAW") return "0.5";
  return side === outcome ? "1" : "0";
}

export function describeOutcome(outcome: WindowOutcome): string {
  if (outcome === "DRAW") return "平局（50-50 派彩）";
  return outcome === "UP" ? "上涨（UP 中奖）" : "下跌（DOWN 中奖）";
}
