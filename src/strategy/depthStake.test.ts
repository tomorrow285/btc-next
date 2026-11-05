import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dec, type DecimalInput } from "../util/decimal.js";
import {
  askCapacity,
  planStakeByDepth,
  tradableAsks,
  vwapForAmount,
  type PriceLevel,
} from "./depthStake.js";
import type { MartingaleSettings } from "./money.js";

const settings: MartingaleSettings = {
  basePrice: 1,
  feeRate: 0.02,
  riskAmount: 10,
  riskCount: 3,
  resetLossStreak: 15,
  resetLossMultiple: 128,
};

const near = (actual: DecimalInput, expected: DecimalInput, tolerance = "1e-9") =>
  assert.ok(
    dec(actual).minus(expected).abs().lt(tolerance),
    `期望 ${expected}，实际 ${actual}`,
  );

const levels = (...rows: Array<[string, string]>): PriceLevel[] =>
  rows.map(([price, size]) => ({ price, size }));

describe("可成交档位", () => {
  it("只保留价格 < 1 − feeRate 的档位，并按价格升序", () => {
    const asks = levels(
      ["0.98", "100"],
      ["0.6", "1"],
      ["0.5", "2"],
      ["0.99", "5"],
    );

    assert.deepEqual(
      tradableAsks(asks, settings.feeRate).map((level) => level.price),
      ["0.5", "0.6"],
    );
  });

  it("过滤掉零价格 / 零数量", () => {
    const asks = levels(["0", "10"], ["0.5", "0"], ["0.4", "1"]);
    assert.deepEqual(
      tradableAsks(asks, settings.feeRate).map((level) => level.price),
      ["0.4"],
    );
  });

  it("容量 = 各可成交档位 price × size 之和", () => {
    const asks = levels(["0.5", "2"], ["0.6", "1"], ["0.98", "100"]);
    near(askCapacity(asks, settings.feeRate), 1.6);
  });
});

describe("逐档吃单均价", () => {
  it("单档：均价就是该档价格", () => {
    const asks = tradableAsks(levels(["0.5", "10"]), settings.feeRate);
    near(vwapForAmount(asks, "1")!, 0.5);
  });

  it("跨档：按吃掉的份额加权", () => {
    // 先吃 0.5 × 2 = 1u，余下 0.2u 吃 0.6 → 份额 2 + 1/3 = 7/3
    // 均价 = 1.2 / (7/3) = 3.6 / 7
    const asks = tradableAsks(
      levels(["0.5", "2"], ["0.6", "100"]),
      settings.feeRate,
    );
    near(vwapForAmount(asks, "1.2")!, "0.5142857142857142857142857142857142857143");
  });

  it("深度不够时返回 null", () => {
    const asks = tradableAsks(levels(["0.5", "2"]), settings.feeRate);
    assert.equal(vwapForAmount(asks, "1.6"), null);
  });
});

describe("按深度推算注额", () => {
  it("无欠账：注额 = 基础注码，均价按该金额算", () => {
    const plan = planStakeByDepth(
      levels(["0.5", "10"]),
      { totalLoss: "0", lossStreak: 0 },
      settings,
    );

    assert.ok(plan);
    near(plan.amountUsdt, 1);
    near(plan.baseExecPrice, 0.5);
    near(plan.execPrice, 0.5);
    near(plan.capacityUsdt, 5);
    assert.equal(plan.depthShortfall, false);
  });

  it("有欠账（常规模式）：补亏注额再加基础注码", () => {
    const plan = planStakeByDepth(
      levels(["0.5", "100"]),
      { totalLoss: "1", lossStreak: 1 },
      settings,
    );

    assert.ok(plan);
    // 报价倍率 2 → 有效倍率 1.96；注额 = 1 + 1 / 0.96
    near(plan.amountUsdt, dec(1).plus(dec(1).div("0.96")).toFixed());
    near(plan.execPrice, 0.5);
  });

  it("有欠账（保守模式）：只补亏，不加基础注码", () => {
    const plan = planStakeByDepth(
      levels(["0.5", "100"]),
      { totalLoss: "1", lossStreak: settings.riskCount },
      settings,
    );

    assert.ok(plan);
    near(plan.amountUsdt, dec(1).div("0.96").toFixed());
  });

  it("深度接不下计划注额：标记 shortfall，不返回 null", () => {
    const plan = planStakeByDepth(
      levels(["0.5", "2"]),
      { totalLoss: "10", lossStreak: 1 },
      settings,
    );

    assert.ok(plan);
    assert.equal(plan.depthShortfall, true);
    near(plan.capacityUsdt, 1);
    near(plan.execPrice, 0.5);
    assert.ok(dec(plan.amountUsdt).gt(plan.capacityUsdt));
  });

  it("连基础注码都接不下 → null", () => {
    const plan = planStakeByDepth(
      levels(["0.5", "1"]),
      { totalLoss: "0", lossStreak: 0 },
      settings,
    );
    assert.equal(plan, null);
  });

  it("没有可成交档位 → null", () => {
    const plan = planStakeByDepth(
      levels(["0.98", "100"]),
      { totalLoss: "1", lossStreak: 1 },
      settings,
    );
    assert.equal(plan, null);
  });
});
