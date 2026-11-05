/** 项目内共享的领域类型。刻意不依赖任何 IO 模块，便于纯逻辑测试。 */

/** 涨跌方向。和下单接口的 BUY/SELL 无关。 */
export type Side = "UP" | "DOWN";

/** 一个窗口的结果方向；DRAW = 到期价恰好等于开盘价（官方 50-50 派彩）。 */
export type WindowOutcome = Side | "DRAW";

/** 策略标识：只保留 B0（跟盘）。 */
export type StrategyId = "B0";

/** 已结算、可供下一窗口策略使用的上一窗口结果。 */
export interface PreviousWindowResult {
  windowStart: number;
  windowEnd: number;
  marketId: number;
  topicId: number;
  outcome: WindowOutcome;
  openPrice: string;
  endPrice: string;
  /** 涨跌幅（%）。正数 = 上涨，负数 = 下跌。 */
  changePct: string;
  judgedAt: number;
}
