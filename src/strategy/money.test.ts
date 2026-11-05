import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dec, type DecimalInput } from "../util/decimal.js";
import {
  canBet,
  effectiveMultiplier,
  emptyBankroll,
  pnlFromFill,
  resetLossThreshold,
  resetReason,
  resultLabel,
  settleBankroll,
  stakeAmount,
  type MartingaleSettings,
} from "./money.js";

const settings: MartingaleSettings = {
  basePrice: 1,
  feeRate: 0.02,
  riskAmount: 10,
  riskCount: 3,
  resetLossStreak: 15,
  resetLossMultiple: 128,
};

const noFee: MartingaleSettings = { ...settings, feeRate: 0 };
const near = (actual: DecimalInput, expected: DecimalInput) =>
  assert.ok(
    dec(actual).minus(expected).abs().lt("1e-12"),
    `期望 ${expected}，实际 ${actual}`,
  );

describe("倍率口径", () => {
  it("有效倍率 = 报价倍率 × (1 − 费率)", () => {
    near(effectiveMultiplier(2, 0.02), 1.96);
    near(effectiveMultiplier(1, 0.02), 0.98);
    near(effectiveMultiplier(2, 0), 2);
  });

  it("低于最小有效倍率（默认 1.3）时不能下注", () => {
    assert.equal(canBet(2, 0.02, 1.3), true); // 1.96
    assert.equal(canBet(1.35, 0.02, 1.3), true); // 1.323
    assert.equal(canBet(1.32, 0.02, 1.3), false); // 1.2936
    assert.equal(canBet(1.02, 0.02, 1.3), false);
  });

  it("倍率刚好达到门槛时允许", () => {
    assert.equal(canBet(1.3266, 0.02, 1.3), true); // 1.300068
  });
});

describe("马丁格尔注码", () => {
  it("首次下注 = 基础注码", () => {
    near(stakeAmount(emptyBankroll(), settings, 2.5), 1);
  });

  it("亏损后 = 基础注码 + TOTAL_LOSS / (有效倍率 − 1)", () => {
    const bankroll = { totalLoss: "1", lossStreak: 1 };
    const multiple = 2.5;
    near(stakeAmount(bankroll, settings, multiple), 1 + 1 / (2.5 * 0.98 - 1));
  });

  it("不收费时回到文档字面公式", () => {
    const bankroll = { totalLoss: "1", lossStreak: 1 };
    near(stakeAmount(bankroll, noFee, 2.5), 1 + 1 / (2.5 - 1));
  });

  it("连败达到 RISK_COUNT 后进入保守模式：去掉基础利润", () => {
    const bankroll = { totalLoss: "3", lossStreak: settings.riskCount };
    near(stakeAmount(bankroll, settings, 2), 3 / (2 * 0.98 - 1));
  });

  it("TOTAL_LOSS 达到 RISK_AMOUNT 后同样进入保守模式", () => {
    const bankroll = { totalLoss: "12", lossStreak: 1 };
    near(stakeAmount(bankroll, settings, 2), 12 / (2 * 0.98 - 1));
  });

  it("保守模式算出低于基础注码时补足到基础注码", () => {
    const bankroll = { totalLoss: "3.96", lossStreak: 3 };
    near(stakeAmount(bankroll, settings, 1 / 0.07), settings.basePrice);
  });

  it("有效倍率 <= 1 时抛错（调用方必须先判断门槛）", () => {
    assert.throws(() => stakeAmount(emptyBankroll(), settings, 1));
  });
});

describe("账本更新", () => {
  it("亏损累加欠账、连败 +1", () => {
    const next = settleBankroll({ totalLoss: "2", lossStreak: 1 }, "-1.5");
    near(next.totalLoss, 3.5);
    assert.equal(next.lossStreak, 2);
  });

  it("盈利扣减欠账、连败归零；扣到 <= 0 归零", () => {
    const next = settleBankroll({ totalLoss: "2", lossStreak: 4 }, "1.2");
    near(next.totalLoss, 0.8);
    assert.equal(next.lossStreak, 0);

    const cleared = settleBankroll({ totalLoss: "1", lossStreak: 1 }, "5");
    near(cleared.totalLoss, 0);
    assert.equal(cleared.lossStreak, 0);
  });

  it("打平状态不变", () => {
    const bankroll = { totalLoss: "2", lossStreak: 2 };
    assert.deepEqual(settleBankroll(bankroll, "0"), bankroll);
  });
});

describe("重新初始化", () => {
  it("阈值 = 基础注码 × RESET_LOSS_MULTIPLE", () => {
    near(resetLossThreshold(settings), 128);
    near(resetLossThreshold({ ...settings, basePrice: 5 }), 640);
  });

  it("连败 14 不触发、15 触发", () => {
    assert.equal(resetReason({ totalLoss: "0", lossStreak: 14 }, settings), null);
    assert.match(
      resetReason({ totalLoss: "0", lossStreak: 15 }, settings) ?? "",
      /连败 15 >= 15/,
    );
  });

  it("TOTAL_LOSS 127.99 不触发、128 触发", () => {
    assert.equal(
      resetReason({ totalLoss: "127.99", lossStreak: 0 }, settings),
      null,
    );
    assert.match(
      resetReason({ totalLoss: "128", lossStreak: 0 }, settings) ?? "",
      /TOTAL_LOSS 128\.0000 >= 128/,
    );
  });
});

describe("盈亏", () => {
  it("成交口径：份额 × 每份派彩 − 实扣", () => {
    near(pnlFromFill("19.6", "1", "1"), 18.6);
    near(pnlFromFill("19.6", "1", "0"), -1);
    near(pnlFromFill("19.6", "1", "0.5"), 8.8);
  });

  it("结果文案", () => {
    assert.equal(resultLabel("0.1"), "赢");
    assert.equal(resultLabel("-0.1"), "输");
    assert.equal(resultLabel("0"), "平");
  });
});
