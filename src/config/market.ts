/**
 * 唯一盘口：BTC 15 分钟涨跌。
 *
 * 重构后不再支持多档位切换，窗口时长、slug 前缀、列表翻页上限都固定在这里，
 * 不再走环境变量覆盖。
 */
export const MARKET = {
  id: "btc15m",
  label: "BTC 15 分钟涨跌",
  slugPrefix: "btc-updown-15m-",
  windowMinutes: 15,
  windowMs: 15 * 60_000,
  /** 首次找锚点最多翻几页。 */
  listMaxPages: 4,
} as const;

export type MarketId = typeof MARKET.id;
