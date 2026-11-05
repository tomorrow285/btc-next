#!/usr/bin/env node
/**
 * 当前状态一屏看。读 data/，不碰网络。
 *
 *   pnpm status
 */
import { config } from "../config/env.js";
import { readMetrics } from "../engine/metrics.js";
import { readPause } from "../engine/pause.js";
import { MARTINGALE_SETTINGS } from "../engine/reset.js";
import { readState } from "../engine/stateStore.js";
import { readTrades } from "../engine/tradeLog.js";
import { resetLossThreshold } from "../strategy/money.js";
import { formatDecimal } from "../util/decimal.js";
import { utcIso } from "../util/time.js";

const state = readState();
const pause = readPause();
const metrics = readMetrics();

console.log("═══ btc-prediction-trader 执行器状态 ═══");
console.log(`运行状态   ${pause ? `⏸ 已暂停（${pause.reason}）` : "▶ 运行中"}`);
if (pause) console.log(`暂停时刻   ${utcIso(pause.at)}`);
console.log(`盘口       ${config.market.id}（${config.market.label}）`);
console.log(`策略       ${config.strategy.kind}`);
console.log(`启动时刻   ${utcIso(state.startedAt)}`);
console.log(`最近回合   ${state.lastRoundAt === null ? "-" : utcIso(state.lastRoundAt)}`);
console.log("");
console.log(`累计盈亏   ${formatDecimal(state.realizedPnl, 4)} USDT      ← 只对账，不参与风控`);
console.log(`累计下注   ${formatDecimal(state.stakedUsdt, 2)} USDT`);
console.log(
  `倍率门槛   有效倍率 >= ${formatDecimal(config.strategy.minEffectiveMultiplier, 4)} 才下单`,
);
console.log(
  `TOTAL_LOSS ${formatDecimal(state.bankroll.totalLoss, 4)}   ` +
    `连败 ${state.bankroll.lossStreak}   ` +
    `（阈值：连败≥${config.strategy.b0.resetLossStreak} 或 ` +
    `TOTAL_LOSS≥${resetLossThreshold(MARTINGALE_SETTINGS)}u）`,
);
console.log(
  `重新初始化 ${state.resets} 次` +
    (state.lastResetAt === null
      ? ""
      : `   最近 ${utcIso(state.lastResetAt)}（${state.lastResetReason}）`),
);
console.log(
  `回合统计   ${state.bets} 笔下单 · 赢 ${state.wins} / 输 ${state.losses} / 平 ${state.flats}`,
);
console.log(`待复核     ${state.reviewOpen} 笔（累计补齐 ${state.reviewsResolved} 笔）`);
console.log(
  `运行指标   决策 买 ${metrics.decisionsBuy} / 跳过 ${metrics.decisionsSkip} · ` +
    `下单 成交 ${metrics.ordersFilled} / 未知 ${metrics.ordersUnknown} / 失败 ${metrics.ordersFailed} · ` +
    `结算 盘面 ${metrics.settlementsPanel} / 链上 ${metrics.settlementsChain} · ` +
    `待复核打开 ${metrics.reviewsOpened} / 解决 ${metrics.reviewsResolved}`,
);

const previous = state.lastWindowResult;
if (previous) {
  console.log(
    `上一窗口   ${utcIso(previous.windowStart)} → ${utcIso(previous.windowEnd)}   ` +
      `${previous.outcome}   涨跌幅 ${formatDecimal(previous.changePct, 4)}%`,
  );
}
if (state.lastError) console.log(`最近错误   ${state.lastError}`);

const rows = readTrades();
console.log(`\n─── 最近 10 条流水（昨日+今日共 ${rows.length} 条）───`);
for (const row of rows.slice(-10)) {
  const pnl = row.pnl === null ? "" : ` 盈亏 ${formatDecimal(row.pnl, 4)}`;
  const code = row.skipCode === null ? "" : `[${row.skipCode}] `;
  const price =
    row.execPrice === null
      ? ""
      : `  均价 ${formatDecimal(row.execPrice, 4)}` +
        (row.avgFillPrice === null
          ? ""
          : `→${formatDecimal(row.avgFillPrice, 4)}`);
  console.log(
    `${utcIso(row.windowStart)}  ${row.status.padEnd(8)} ${String(row.side ?? "-").padEnd(4)} ` +
      `${row.resultSide ?? ""} ${pnl}${price}  ${code}${row.error ?? row.reason}`,
  );
}
