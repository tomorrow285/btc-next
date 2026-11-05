#!/usr/bin/env node
/**
 * 账户自检（全部只读）：钱包、余额、配额、持仓。
 *
 *   pnpm account
 */
import {
  listWallets,
  paymentOptions,
  positionSummary,
  quota,
} from "../binance/accountApi.js";

const wallets = await listWallets();
if (wallets.length === 0) {
  console.log("❌ 该 API Key 名下没有预测钱包");
  process.exit(1);
}

console.log(`✅ API Key 有效，共 ${wallets.length} 个预测钱包`);

for (const wallet of wallets) {
  console.log(`\n── 钱包 ${wallet.walletAddress}`);
  console.log(`   walletId  ${wallet.walletId}`);

  const [options, dailyQuota, positions] = await Promise.all([
    paymentOptions(),
    quota(),
    positionSummary(wallet.walletAddress),
  ]);

  console.log("   可用余额");
  for (const option of options) {
    console.log(
      `     ${option.accountType.padEnd(8)} ${option.availableBalance.padStart(12)} USDT` +
        `${option.enabled ? "" : "（未启用）"}`,
    );
  }

  console.log(`   当日配额  ${dailyQuota.remainingDailyLimit} / ${dailyQuota.dailyLimit}`);
  console.log("   持仓概览");
  console.log(
    `     钱包余额 ${positions.walletBalance}   持仓市值 ${positions.positionValue}   ` +
      `合计 ${positions.totalValue}`,
  );
  console.log(
    `     今日已实现盈亏 ${positions.todayRealizedPnl}   待领取 ${positions.claimable}`,
  );
  console.log(
    `     进行中 ${positions.ongoingCount} · 已结束 ${positions.endedCount} · ` +
      `待领取 ${positions.pendingClaimCount}`,
  );
}
