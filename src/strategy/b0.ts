/**
 * 策略 B0 · 跟盘
 *
 * 规则：买上一窗口获胜的方向，不看倍率；注码走马丁格尔。
 * 没有上一窗口结果（首轮、断档、上一窗口平局）时跳过本窗口。
 *
 * 执行器会先做「查不到上盘结果 / 上盘 DRAW」的主动跳过，
 * 这里再兜一层，保证纯函数在任何输入下都不会臆测方向。
 */
import type { PreviousWindowResult } from "../domain.js";
import type { Strategy, StrategyDecision } from "./types.js";

export class FollowPreviousStrategy implements Strategy {
  readonly id = "B0" as const;
  readonly label = "跟盘";

  decide(previous: PreviousWindowResult | null): StrategyDecision {
    if (!previous) {
      return { action: "SKIP", reason: "B0：没有上一窗口结果，跳过" };
    }
    if (previous.outcome === "DRAW") {
      return { action: "SKIP", reason: "B0：上一窗口平局，没有获胜方向，跳过" };
    }

    return {
      action: "BUY",
      side: previous.outcome,
      reason: `B0 跟盘：上一窗口 ${previous.outcome} 获胜`,
    };
  }
}

export function createStrategy(): Strategy {
  return new FollowPreviousStrategy();
}
