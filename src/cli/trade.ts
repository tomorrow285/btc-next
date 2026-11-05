#!/usr/bin/env node
/**
 * 交易层手动工具。
 *
 *   pnpm trade quote [USDT] [UP|DOWN]   只报价，不下单（默认 1 USDT）
 *   pnpm trade buy <USDT> [UP|DOWN]     ⚠️ 真实下单；省略方向时由 B0 决定
 *   pnpm trade orders                   列出当前挂单
 *   pnpm trade settled [N]              列出已结算记录
 */
import { listWallets, settledPositions } from "../binance/accountApi.js";
import {
  fromWei,
  getQuote,
  listActiveOrders,
  placeOrder,
  toWei,
} from "../binance/tradeApi.js";
import { config } from "../config/env.js";
import { selectFundingAccount } from "../engine/funding.js";
import { readState } from "../engine/stateStore.js";
import { askBook } from "../engine/trading.js";
import { bestAsk } from "../market/orderBook.js";
import {
  currentWindow,
  nextWindow,
  tradeIdOf,
  type PredictionWindow,
} from "../market/window.js";
import { createStrategy } from "../strategy/b0.js";
import { dec, decOrNull, formatDecimal, type DecimalInput } from "../util/decimal.js";
import { formatDuration, utcIso } from "../util/time.js";

const fixed = (value: DecimalInput | null | undefined, digits = 4) =>
  formatDecimal(value, digits);

async function openWindow(): Promise<PredictionWindow> {
  const now = Date.now();
  const window = (await currentWindow(now)) ?? (await nextWindow(now));
  if (!window) throw new Error("时间表里没有可用窗口");
  return window;
}

function describeWindow(window: PredictionWindow): string {
  const now = Date.now();
  const phase =
    now < window.startMs
      ? `距开盘 ${formatDuration(window.startMs - now)}`
      : now < window.endMs
        ? `已开盘 +${formatDuration(now - window.startMs)} / 剩 ${formatDuration(window.endMs - now)}`
        : `已结束 ${formatDuration(now - window.endMs)}`;
  return (
    `窗口   ${utcIso(window.startMs)} → ${utcIso(window.endMs)}   ` +
    `marketId=${window.marketId}   ${window.tradingStatus}   ${phase}`
  );
}

const [, , command, ...args] = process.argv;

// ---------- orders ----------

if (command === "orders") {
  const [wallet] = await listWallets();
  if (!wallet) throw new Error("没有预测钱包");

  const orders = await listActiveOrders(wallet.walletAddress);
  console.log(`挂单 ${orders.length} 笔`);
  for (const order of orders) {
    console.log(
      `  ${order.orderId}  ${order.marketTitle}  ${order.outcome}  ` +
        `${order.side} ${order.orderType} ${order.status}  已成交 ${order.fillPercentage}%  ` +
        `价格 ${order.price}`,
    );
  }
  process.exit(0);
}

// ---------- settled ----------

if (command === "settled") {
  const [wallet] = await listWallets();
  if (!wallet) throw new Error("没有预测钱包");

  const rows = await settledPositions(wallet.walletAddress, Number(args[0] ?? 10));
  console.log(`已结算 ${rows.length} 笔\n`);
  for (const position of rows) {
    const when = position.settledDate ? utcIso(position.settledDate) : "-";
    console.log(
      `${when}  ${position.marketTitle}  →  ${position.outcomeName}  ` +
        `${position.isWinner ? "赢" : "输"}`,
    );
    console.log(
      `   份额 ${position.shares}  均价 ${position.avgPrice}  成本 ${position.totalCost}  ` +
        `结算价值 ${position.value}  已实现盈亏 ${position.realizedPnl}  可领取 ${position.claimAmount}`,
    );
  }
  process.exit(0);
}

// ---------- quote / buy ----------

const amount = decOrNull(args[0] ?? "1");
if (amount === null || !amount.gt(0)) {
  throw new Error(`金额不合法：${args[0]}`);
}
const amountUsdt = amount.toFixed();

const [wallet] = await listWallets();
if (!wallet) throw new Error("没有预测钱包");

const window = await openWindow();
console.log(describeWindow(window));

let side: "UP" | "DOWN";
const forced = args[1]?.toUpperCase();

if (forced === "UP" || forced === "DOWN") {
  side = forced;
  console.log(`方向   ${side}（命令行指定）`);
} else {
  const state = readState();
  const previous =
    state.lastWindowResult?.windowEnd === window.startMs
      ? state.lastWindowResult
      : null;
  const decision = createStrategy().decide(previous);

  if (decision.action === "SKIP") {
    console.log(`\nB0 判定：跳过本轮 —— ${decision.reason}`);
    console.log("（要强制下单，把方向写在命令行上：pnpm trade buy 1 UP）");
    process.exit(0);
  }

  side = decision.side;
  console.log(`方向   ${side}（B0：${decision.reason}）`);
}

const book = await askBook(window, side).catch(() => null);
const ask = book ? bestAsk(book) : null;
console.log(
  `盘口   ${side} 卖一 ${fixed(ask)}（倍率 ${ask === null ? "-" : fixed(dec(1).div(ask), 3)}）`,
);

if (ask === null) {
  console.log(`\n⚠️ ${side} 方向没有可用卖单，无法报价`);
  process.exit(0);
}

const outcome = side === "UP" ? window.up : window.down;
if (!outcome) throw new Error(`窗口没有 ${side} 方向`);
if (window.tradingStatus !== "OPEN") {
  throw new Error(`窗口不可下单，tradingStatus=${window.tradingStatus}`);
}

const funding = await selectFundingAccount();
console.log(`出资   ${funding.label}（可用 ${funding.availableUsdt} USDT）`);

const quote = await getQuote({
  walletAddress: wallet.walletAddress,
  tokenId: outcome.tokenId,
  side: "BUY",
  amountInWei: toWei(amountUsdt),
  orderType: "MARKET",
  slippageBps: config.order.slippageBps,
  fundingSource: funding.fundingSource,
});

const averagePrice = decOrNull(quote.averagePrice) ?? dec(0);
const grossShares = averagePrice.gt(0) ? amount.div(averagePrice) : dec(0);
const feeShares = dec(fromWei(quote.feeAmountWei));
const netShares = grossShares.minus(feeShares);
const effectiveMultiple = amount.gt(0) ? netShares.div(amount) : dec(0);

console.log(
  `\n报价   ${fixed(amount, 6)} USDT → 毛 ${fixed(grossShares, 6)} 份，` +
    `扣手续费 ${fixed(feeShares, 6)} 份 → 到手 ${fixed(netShares, 6)} 份`,
);
console.log(
  `       均价 ${fixed(quote.averagePrice, 6)}（有效倍率 ${fixed(effectiveMultiple)}）  ` +
    `概率 ${quote.chance}  价格影响 ${fixed(quote.priceImpact, 6)}`,
);
console.log(`       quoteId ${quote.quoteId}  tradeId ${tradeIdOf(window)}`);

if (command !== "buy") {
  console.log("\n（quote 模式，未下单。要真下单用：pnpm trade buy <USDT>）");
  process.exit(0);
}

console.log("\n⚠️  真实下单中…");
const orderId = await placeOrder({
  walletAddress: wallet.walletAddress,
  walletId: wallet.walletId,
  quoteId: quote.quoteId,
  orderType: "MARKET",
  timeInForce: "FOK",
  accountType: funding.accountType,
  slippageBps: config.order.slippageBps,
  fundingSource: funding.fundingSource,
});

console.log(`✅ 订单已提交 orderId=${orderId}（提交结果不等于成交，请用 pnpm trade orders 回查）`);
