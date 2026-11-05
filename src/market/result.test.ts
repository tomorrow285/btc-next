import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dec, type DecimalInput } from "../util/decimal.js";
import {
  changePctOf,
  describeOutcome,
  judgeByPrice,
  judgeWindowPrices,
  payoutPerShare,
} from "./result.js";

const near = (actual: DecimalInput, expected: DecimalInput) =>
  assert.ok(
    dec(actual).minus(expected).abs().lt("1e-12"),
    `期望 ${expected}，实际 ${actual}`,
  );

describe("窗口输赢判定", () => {
  it("到期价 > 开盘价 → UP", () => {
    assert.equal(judgeByPrice("100", "100.1"), "UP");
  });

  it("到期价 < 开盘价 → DOWN", () => {
    assert.equal(judgeByPrice("100", "99.9"), "DOWN");
  });

  it("完全相等 → DRAW（官方 50-50 派彩）", () => {
    assert.equal(judgeByPrice("100", "100"), "DRAW");
  });

  it("任一价格缺失或非法 → null，不猜", () => {
    assert.equal(judgeByPrice(null, "100"), null);
    assert.equal(judgeByPrice("100", null), null);
    assert.equal(judgeByPrice("NaN", "100"), null);
    assert.equal(judgeByPrice("0", "100"), "UP");
  });
});

describe("涨跌幅", () => {
  it("按开盘价计算百分比，正数表示上涨", () => {
    near(changePctOf("100", "100.1") ?? "0", 0.1);
    near(changePctOf("100", "99.9") ?? "0", -0.1);
  });

  it("价格缺失或开盘价非正 → null", () => {
    assert.equal(changePctOf(null, "100"), null);
    assert.equal(changePctOf("0", "100"), null);
    assert.equal(changePctOf("-1", "100"), null);
  });
});

describe("一次性判定", () => {
  it("两个价格都就绪时给出完整结果", () => {
    const judgement = judgeWindowPrices("100", "100.25");
    assert.ok(judgement);
    assert.equal(judgement.outcome, "UP");
    near(judgement.changePct, 0.25);
  });

  it("价格未就绪 → null", () => {
    assert.equal(judgeWindowPrices(null, "100"), null);
  });
});

describe("每份派彩", () => {
  it("买对 1，买错 0，平局 0.5", () => {
    assert.equal(payoutPerShare("UP", "UP"), "1");
    assert.equal(payoutPerShare("UP", "DOWN"), "0");
    assert.equal(payoutPerShare("UP", "DRAW"), "0.5");
    assert.equal(payoutPerShare("DOWN", "DRAW"), "0.5");
  });

  it("结果文案", () => {
    assert.match(describeOutcome("UP"), /上涨/);
    assert.match(describeOutcome("DOWN"), /下跌/);
    assert.match(describeOutcome("DRAW"), /50-50/);
  });
});
