#!/usr/bin/env node
/**
 * 人工暂停交易：只落暂停标记，执行器进程继续活着但不下单。
 *
 *   pnpm pause "手动暂停"
 */
import { setPause } from "../engine/pause.js";
import { readState } from "../engine/stateStore.js";

const reason = process.argv.slice(2).join(" ").trim() || "手动暂停";
const state = readState();

setPause({
  at: Date.now(),
  reason,
  realizedPnl: state.realizedPnl,
  totalLoss: state.bankroll.totalLoss,
});

console.log(`⏸ 已暂停交易：${reason}`);
console.log("   执行器不会再下单；恢复：pnpm resume");
