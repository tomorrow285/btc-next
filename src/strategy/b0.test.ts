import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PreviousWindowResult, WindowOutcome } from "../domain.js";
import { createStrategy, FollowPreviousStrategy } from "./b0.js";
import type { StrategyDecision } from "./types.js";

function previous(outcome: WindowOutcome, changePct = "0"): PreviousWindowResult {
  return {
    windowStart: 1_000,
    windowEnd: 2_000,
    marketId: 42,
    topicId: 7,
    outcome,
    openPrice: "100",
    endPrice: "100",
    changePct,
    judgedAt: 2_001,
  };
}

function expectBuy(decision: StrategyDecision) {
  assert.equal(
    decision.action,
    "BUY",
    `期望 BUY，实际 SKIP：${decision.action === "SKIP" ? decision.reason : ""}`,
  );
  return decision as Extract<StrategyDecision, { action: "BUY" }>;
}

describe("策略 B0 · 跟盘", () => {
  const strategy = new FollowPreviousStrategy();

  it("买上一窗口获胜方向", () => {
    assert.equal(expectBuy(strategy.decide(previous("DOWN"))).side, "DOWN");
    assert.equal(expectBuy(strategy.decide(previous("UP"))).side, "UP");
  });

  it("没有上一窗口结果时跳过", () => {
    const decision = strategy.decide(null);
    assert.equal(decision.action, "SKIP");
  });

  it("上一窗口平局时跳过（没有获胜方向）", () => {
    const decision = strategy.decide(previous("DRAW"));
    assert.equal(decision.action, "SKIP");
    assert.match(decision.action === "SKIP" ? decision.reason : "", /平局/);
  });

  it("工厂返回 B0", () => {
    assert.equal(createStrategy().id, "B0");
  });
});
