#!/usr/bin/env node
/**
 * 盘面打印（只读）。展示两侧深度供人工观察；执行器交易时只查要买的一侧。
 *
 *   pnpm board              打一次当前（或下一个）窗口的实时盘面
 *   pnpm board --watch      每 5 秒刷新
 *   pnpm board --watch 2    自定义刷新间隔（秒）
 */
import { orderBook, type Outcome } from "../binance/marketApi.js";
import { serverTimeOffset, topOfBook } from "../binance/spotApi.js";
import { config } from "../config/env.js";
import { readState } from "../engine/stateStore.js";
import { depthOf, type Depth, type FillEstimate } from "../market/orderBook.js";
import { currentWindow, nextWindow, type PredictionWindow } from "../market/window.js";
import { dec, decOrNull, formatDecimal, type DecimalInput } from "../util/decimal.js";
import { logEvent } from "../util/log.js";
import { formatDuration, utcIso } from "../util/time.js";

const fixed = (value: DecimalInput | null | undefined, digits = 2): string =>
  formatDecimal(value, digits);

const percent = (value: DecimalInput | null | undefined): string => {
  const number = decOrNull(value);
  return number === null ? "-" : `${number.times(100).toFixed(1)}%`;
};

const multiplier = (price: DecimalInput | null | undefined): string | null => {
  const value = decOrNull(price);
  return value !== null && value.gt(0) ? dec(1).div(value).toFixed() : null;
};

// CJK / 全角字符占两列，padEnd 按码元算会错位。
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE.test(char) ? 2 : 1;
  return width;
}

interface Column {
  title: string;
  width: number;
  align: "left" | "right";
}

const COLUMNS: readonly Column[] = [
  { title: "方向", width: 6, align: "left" },
  { title: "概率", width: 6, align: "right" },
  { title: "倍率", width: 7, align: "right" },
  { title: "买一/卖一", width: 13, align: "left" },
  { title: "价差", width: 6, align: "right" },
  { title: "卖档", width: 5, align: "right" },
  { title: "+2%内(USDT)", width: 12, align: "right" },
  { title: "+5%内(USDT)", width: 12, align: "right" },
  { title: "100u均价", width: 10, align: "right" },
  { title: "500u均价", width: 10, align: "right" },
  { title: "快照滞后", width: 8, align: "right" },
];

function renderRow(cells: readonly string[]): string {
  return COLUMNS.map((column, index) => {
    const text = cells[index] ?? "";
    const gap = " ".repeat(Math.max(0, column.width - displayWidth(text)));
    return column.align === "right" ? gap + text : text + gap;
  }).join(" ");
}

const fillCell = (estimate: FillEstimate): string => {
  const shares = decOrNull(estimate.shares);
  return shares !== null && shares.gt(0)
    ? `${fixed(estimate.avgPrice, 4)}${estimate.filled ? "" : "*"}`
    : "-";
};

function depthCells(side: string, outcome: Outcome | undefined, depth: Depth): string[] {
  return [
    side,
    percent(outcome?.chance),
    fixed(multiplier(outcome?.price), 3),
    `${fixed(depth.bestBid, 4)}/${fixed(depth.bestAsk, 4)}`,
    fixed(depth.spread, 4),
    String(depth.askLevels),
    fixed(depth.usdt2pct),
    fixed(depth.usdt5pct),
    fillCell(depth.fill100),
    fillCell(depth.fill500),
    fixed(depth.lagSec, 1),
  ];
}

function phaseOf(window: PredictionWindow, now: number): string {
  if (now < window.startMs) return `距开盘 ${formatDuration(window.startMs - now)}`;
  if (now < window.endMs) {
    return `已开盘 +${formatDuration(now - window.startMs)} / 剩 ${formatDuration(window.endMs - now)}`;
  }
  return `已结束 ${formatDuration(now - window.endMs)}`;
}

async function printBoard(): Promise<void> {
  const now = Date.now();
  const window = (await currentWindow(now)) ?? (await nextWindow(now));
  if (!window) {
    console.log("时间表里没有可用窗口（可能超出时间表覆盖范围）");
    return;
  }

  const [upBook, downBook, spot, skewMs] = await Promise.all([
    window.up ? orderBook(window.marketId, window.up.tokenId) : null,
    window.down ? orderBook(window.marketId, window.down.tokenId) : null,
    topOfBook().catch(() => null),
    serverTimeOffset().catch(() => null),
  ]);

  const serverNow = skewMs === null ? now : now + skewMs;
  const upDepth = upBook ? depthOf(upBook, serverNow) : null;
  const downDepth = downBook ? depthOf(downBook, serverNow) : null;

  console.log(`\n══ 币安预测盘 · ${config.market.label} ══  ${utcIso(now)}`);
  console.log(
    `窗口   ${utcIso(window.startMs)} → ${utcIso(window.endMs)}   ` +
      `marketId=${window.marketId}   ${window.tradingStatus}   ${phaseOf(window, now)}`,
  );

  const previous = readState().lastWindowResult;
  if (previous) {
    console.log(
      `上一窗 ${utcIso(previous.windowStart)} → ${utcIso(previous.windowEnd)}   ` +
        `${previous.outcome}   涨跌幅 ${formatDecimal(previous.changePct, 4)}%`,
    );
  }

  const deviation =
    spot && window.openPrice !== null ? dec(spot.mid).minus(window.openPrice) : null;

  console.log(
    `目标价 ${window.openPrice === null ? "未定（开盘那一刻写入）" : fixed(window.openPrice, 2)}` +
      (spot ? `    现价 ${fixed(spot.mid)}（买 ${fixed(spot.bid)} / 卖 ${fixed(spot.ask)}）` : "    现价 取数失败") +
      (deviation !== null
        ? `    偏离 ${deviation.gte(0) ? "+" : ""}${deviation.toFixed(2)}`
        : ""),
  );
  console.log(
    `盘面   参与 ${window.participantCount ?? "-"} 人 · 成交 ${fixed(window.volume)} · 流动性 ${fixed(window.liquidity)}`,
  );

  if (skewMs !== null) {
    const seconds = skewMs / 1000;
    console.log(
      `时钟   本机比币安${seconds >= 0 ? "慢" : "快"} ${Math.abs(seconds).toFixed(2)}s` +
        `${Math.abs(seconds) > 1 ? "  ⚠️ 偏差偏大" : ""}`,
    );
  }

  console.log("");
  console.log(renderRow(COLUMNS.map((column) => column.title)));
  if (upDepth) console.log(renderRow(depthCells("UP", window.up, upDepth)));
  if (downDepth) console.log(renderRow(depthCells("DOWN", window.down, downDepth)));
  console.log("  份额价 0~1（1 份中奖结算 $1）；买某方向 = 吃它的卖单，故看「卖一」与卖侧容量");
  console.log("  * = 该金额吃不满盘口，显示的是已吃到部分的均价");
}

const watchIndex = process.argv.indexOf("--watch");

if (watchIndex < 0) {
  try {
    await printBoard();
  } catch (error) {
    console.error(`❌ 读取盘面失败：${error instanceof Error ? error.message : String(error)}`);
    console.error("   检查网络出口 / 代理配置（见 README「网络与部署」）。");
    process.exit(1);
  }
} else {
  const seconds = Number(process.argv[watchIndex + 1] ?? 5);
  const intervalMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;
  console.log(`每 ${intervalMs / 1000}s 刷新一次，Ctrl-C 退出`);
  for (;;) {
    try {
      await printBoard();
    } catch (error) {
      logEvent("board_error", {
        message: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
