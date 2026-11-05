/** 策略层的公共契约（重构后只有 B0 一个策略）。 */
import type { PreviousWindowResult, Side, StrategyId } from "../domain.js";

export type StrategyDecision =
  | { action: "BUY"; side: Side; reason: string }
  | { action: "SKIP"; reason: string };

export interface Strategy {
  readonly id: StrategyId;
  readonly label: string;
  /** 只看上一窗口结果，不做网络 IO。 */
  decide(previous: PreviousWindowResult | null): StrategyDecision;
}
