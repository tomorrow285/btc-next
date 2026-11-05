/**
 * 十进制运算的唯一入口。
 *
 * 项目内所有价格、金额、倍率、盈亏、涨跌幅都用 bignumber.js 计算，
 * 只在展示或写入外部系统时转成字符串；**不做浮点中间计算**。
 */
import BigNumber from "bignumber.js";

BigNumber.config({
  DECIMAL_PLACES: 40,
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
});

export { BigNumber };

export type DecimalInput = BigNumber.Value;

export function dec(value: DecimalInput): BigNumber {
  return new BigNumber(value);
}

export function decOrNull(value: DecimalInput | null | undefined): BigNumber | null {
  if (value === null || value === undefined || value === "") return null;
  const number = new BigNumber(value);
  return number.isFinite() ? number : null;
}

/** 规范化为普通十进制字符串（不使用科学计数法）。 */
export function decimal(value: DecimalInput): string {
  const number = dec(value);
  return number.isFinite() ? number.toFixed() : "0";
}

export function decimalOrNull(value: DecimalInput | null | undefined): string | null {
  const number = decOrNull(value);
  return number === null ? null : number.toFixed();
}

/** 展示用：固定小数位；空值或非法值显示 "-"。 */
export function formatDecimal(
  value: DecimalInput | null | undefined,
  digits = 2,
): string {
  const number = decOrNull(value);
  return number === null ? "-" : number.toFixed(digits);
}

export function maxDecimal(a: DecimalInput, b: DecimalInput): BigNumber {
  const left = dec(a);
  const right = dec(b);
  return left.gte(right) ? left : right;
}
