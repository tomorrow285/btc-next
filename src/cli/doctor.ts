#!/usr/bin/env node
/**
 * 只读自检（绝不下单 / 撤单 / 划转）。
 *
 *   pnpm doctor
 *
 * 检查项：
 *   - 配置与 Node 环境
 *   - 币安现货接口与时钟偏差
 *   - 预测盘公开接口
 *   - 出口 IP（用于核对 API Key 白名单）
 *   - API Key / 钱包 / 余额 / 配额 / 持仓
 */
import {
  listWallets,
  paymentOptions,
  positionSummary,
  quota,
} from "../binance/accountApi.js";
import { listMarketTopics } from "../binance/marketApi.js";
import { serverTimeOffset, topOfBook } from "../binance/spotApi.js";
import { config } from "../config/env.js";
import { formatDecimal } from "../util/decimal.js";

let failures = 0;

function pass(label: string, detail = ""): void {
  console.log(`✅ ${label}${detail ? `  ${detail}` : ""}`);
}

function fail(label: string, detail: string): void {
  failures += 1;
  console.log(`❌ ${label}  ${detail}`);
}

function warn(label: string, detail: string): void {
  console.log(`⚠️ ${label}  ${detail}`);
}

async function check(label: string, task: () => Promise<string>): Promise<void> {
  try {
    pass(label, await task());
  } catch (error) {
    fail(label, error instanceof Error ? error.message : String(error));
  }
}

console.log("═══ btc-prediction-trader 只读自检 ═══");
console.log(`Node       ${process.version}`);
console.log(`盘口       ${config.market.id}（${config.market.label}）`);
console.log(`策略       ${config.strategy.kind}`);
console.log(`数据目录   ${config.dataDir}`);
console.log(
  `倍率门槛   有效倍率 >= ${formatDecimal(config.strategy.minEffectiveMultiplier, 4)}`,
);
console.log("");

// ---------- 网络与公开接口 ----------

await check("币安现货接口 / 时钟", async () => {
  const [book, skew] = await Promise.all([topOfBook(), serverTimeOffset()]);
  return (
    `${config.market.spotSymbol} mid=${book.mid}` +
    `，本机比币安${skew >= 0 ? "慢" : "快"} ${Math.abs(skew).toFixed(0)}ms`
  );
});

await check("预测盘公开接口", async () => {
  const topics = await listMarketTopics(1, 0);
  if (topics.length === 0) throw new Error("market/list 返回空列表");
  return `market/list 可用（返回 ${topics.length} 条）`;
});

// 出口 IP 只用于人工核对白名单，失败不算致命。
try {
  const response = await fetch("https://api.ipify.org?format=json", {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { ip?: string };
  pass("出口 IP", body.ip ?? "未知");
} catch {
  warn("出口 IP", "查询失败（不影响交易，仅用于核对白名单）");
}

// ---------- 账户（需要 API Key） ----------

console.log("");
if (!config.binance.apiKey || !config.binance.apiSecret) {
  fail("API Key", "缺少 BINANCE_API_KEY / BINANCE_API_SECRET");
} else {
  let wallets: Awaited<ReturnType<typeof listWallets>> = [];
  try {
    wallets = await listWallets();
    if (wallets.length === 0) throw new Error("该 API Key 名下没有预测钱包");
    pass("API Key / 钱包", `有效，共 ${wallets.length} 个预测钱包`);
  } catch (error) {
    fail("API Key / 钱包", error instanceof Error ? error.message : String(error));
  }

  for (const wallet of wallets) {
    console.log(`\n── 钱包 ${wallet.walletAddress}`);

    try {
      const options = await paymentOptions();
      const enabled = options.filter((option) => option.enabled);
      if (enabled.length === 0) {
        warn("支付账户", "没有已启用的支付账户");
      } else {
        pass(
          "支付账户",
          enabled
            .map((option) => `${option.accountType}=${option.availableBalance}`)
            .join(" / "),
        );
      }
    } catch (error) {
      fail("支付账户", error instanceof Error ? error.message : String(error));
    }

    try {
      const daily = await quota();
      pass("当日配额", `剩余 ${daily.remainingDailyLimit} / ${daily.dailyLimit}`);
    } catch (error) {
      fail("当日配额", error instanceof Error ? error.message : String(error));
    }

    try {
      const summary = await positionSummary(wallet.walletAddress);
      pass(
        "持仓概览",
        `合计 ${summary.totalValue}，今日已实现 ${summary.todayRealizedPnl}，` +
          `待领取 ${summary.claimable}，进行中 ${summary.ongoingCount} 笔`,
      );
    } catch (error) {
      fail("持仓概览", error instanceof Error ? error.message : String(error));
    }
  }
}

console.log("");
if (failures > 0) {
  console.log(`❌ 自检完成：${failures} 项失败`);
  process.exit(1);
}
console.log("✅ 自检完成：全部通过");
