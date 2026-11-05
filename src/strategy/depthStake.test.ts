import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dec, type BigNumber, type DecimalInput } from "../util/decimal.js";
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

/**
 * 回归：注额必须按「这个注额自己吃出来的均价」解。
 *
 * 盘口刻意做成「1u 只吃第一档、50u 已经吃到第二档」：
 *   0.5 × 2（共 1u）→ 0.6 × 100 → 0.7 × 1000，容量 761u
 * 旧实现拿「1u 的均价 0.5」一次算出注额 52.08u，但那笔钱实际吃到 0.5977，
 * 赢了只赚 33.3u —— 补不平 50u 的欠账。新实现解出的注额是 88.6u。
 */
describe("注额按自身均价解（2026-11-01 21:15 教训）", () => {
  const book = levels(["0.5", "2"], ["0.6", "100"], ["0.7", "1000"]);

  const winPnlAt = (asks: readonly PriceLevel[], amount: DecimalInput): BigNumber => {
    const vwap = vwapForAmount(tradableAsks(asks, settings.feeRate), amount);
    assert.ok(vwap !== null, `盘口吃不下 ${amount}`);
    return dec(amount).times(dec(1).minus(settings.feeRate).div(vwap).minus(1));
  };

  it("保守模式：解出的注额刚好补平欠账，旧口径的注额补不平", () => {
    const plan = planStakeByDepth(book, { totalLoss: "50", lossStreak: 4 }, settings);
    assert.ok(plan);

    near(plan.amountUsdt, "88.6", "1e-6");
    const win = winPnlAt(book, plan.amountUsdt);
    assert.ok(win.gte(dec(50)), `赢时只能赚 ${win}，补不平 50`);
    near(win, 50, "1e-6");

    // 旧口径：按 1u 的均价 0.5 一次算完 → 50 / 0.96 = 52.08u
    const legacyAmount = dec(50).div(dec(1).minus(settings.feeRate));
    const legacyWin = winPnlAt(book, legacyAmount.toFixed());
    assert.ok(
      legacyWin.lt(dec(50)),
      `旧口径本应补不平，实际却赚了 ${legacyWin}`,
    );
    assert.ok(dec(plan.amountUsdt).gt(legacyAmount), "新口径的注额应大于旧口径");
  });

  it("常规模式：解出的注额同样补得平（另加一个基础注码的利润）", () => {
    const plan = planStakeByDepth(book, { totalLoss: "5", lossStreak: 0 }, settings);
    assert.ok(plan);

    near(plan.amountUsdt, "8.3789473684210526", "1e-6");
    assert.ok(winPnlAt(book, plan.amountUsdt).gte(dec(5)));
  });

  it("可成交均价与注额自洽", () => {
    const plan = planStakeByDepth(book, { totalLoss: "50", lossStreak: 4 }, settings);
    assert.ok(plan);
    near(
      plan.execPrice,
      vwapForAmount(tradableAsks(book, settings.feeRate), plan.amountUsdt) ?? "-1",
      "1e-9",
    );
  });
});
