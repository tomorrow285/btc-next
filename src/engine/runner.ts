/**
 * 执行器主循环。
 *
 * 一个回合（15 分钟窗口）：
 *   等入场 → 解析上一窗口结果 → 查单侧盘口 → B0 决策 → 下单（MARKET+FOK）
 *   → 每窗一次链上对账 → 收盘盘面自判 → 检查重置 → 进入下一窗口。
 *
 * 设计约束：
 *   - 每窗口最多一注；
 *   - 状态全部落盘，进程可随时重启；
 *   - 启动阶段（钱包 / 支付账户）失败即退出：没有交易主体，继续跑没有意义；
 *   - 主循环的每个步骤单独兜底：失败只记 error 日志（带 scope）并跳过本轮，
 *     不让单个步骤的异常拖垮整个进程；
 *   - 结算/对账属于旁路能力，内部自行容错。
 */
import { listWallets } from "../binance/accountApi.js";
import { config } from "../config/env.js";
import { currentWindow, nextWindow, tradeIdOf } from "../market/window.js";
import { createStrategy } from "../strategy/b0.js";
import { resetLossThreshold } from "../strategy/money.js";
import { sleep } from "../util/async.js";
import { errorText, logEvent } from "../util/log.js";
import { safeAsync, safeSync } from "../util/safe.js";
import { selectFundingAccount } from "./funding.js";
import { acquireInstanceLock } from "./instanceLock.js";
import { readPause } from "./pause.js";
import { applyResetIfNeeded, MARTINGALE_SETTINGS } from "./reset.js";
import { runRound, type EngineContext } from "./round.js";
import { markHandled, recordNoBet } from "./roundSupport.js";
import { catchUpOnce } from "./settlement/catchup.js";
import { settleAfterClose } from "./settlement/panel.js";
import { syncStateFromTrades } from "./stateSync.js";
import { readState } from "./stateStore.js";

/** 启动阶段没有兜底：记录带 scope 的 fatal 日志后继续向上抛。 */
async function bootStep<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logEvent("error", { scope, fatal: true, message: errorText(error) }, "error");
    throw error;
  }
}

export async function run(): Promise<void> {
  // 先占锁再碰网络：同一 DATA_DIR 下只允许一个执行器。
  const lock = acquireInstanceLock();
  try {
    await runEngine();
  } finally {
    lock.release();
  }
}

/** 执行器主循环本体；单实例锁的获取/释放由 `run` 负责。 */
async function runEngine(): Promise<void> {
  const wallet = await bootStep("list_wallets", async () => {
    const [first] = await listWallets();
    if (!first) throw new Error("没有预测钱包");
    return first;
  });

  // 启动时只选一次支付账户：余额最多的已启用账户，后续所有订单复用。
  const funding = await bootStep("select_funding_account", () => selectFundingAccount());
  const strategy = createStrategy();
  const ctx: EngineContext = { wallet, funding, strategy };

  logEvent("startup", {
    wallet: wallet.walletAddress,
    funding: {
      accountType: funding.accountType,
      fundingSource: funding.fundingSource,
      label: funding.label,
      availableUsdt: funding.availableUsdt,
    },
    market: config.market.id,
    windowMinutes: config.market.windowMinutes,
    strategy: strategy.id,
    strategyLabel: strategy.label,
    entryDelayS: config.timing.entryDelayS,
    entryWindowS: config.timing.entryWindowS,
    judgeDelayS: config.timing.judgeDelayS,
    feeRate: config.strategy.feeRate,
    minEffectiveMultiplier: config.strategy.minEffectiveMultiplier,
    basePrice: config.strategy.b0.basePrice,
    resetLossThreshold: resetLossThreshold(MARTINGALE_SETTINGS),
    live: true,
  });

  // 启动补一次结算（只做链上对账）。
  await safeAsync("startup_catchup", () => catchUpOnce(wallet), undefined);

  // 根据流水校正 state 的窗口推进字段；失败只记日志，继续进入主循环。
  const synced = safeSync("sync_state", () => syncStateFromTrades(), null);
  if (synced) {
    logEvent("state_synced", {
      realizedPnl: synced.realizedPnl,
      totalLoss: synced.bankroll.totalLoss,
      lossStreak: synced.bankroll.lossStreak,
      bets: synced.bets,
      reviewOpen: synced.reviewOpen,
      lastHandledWindowStart: synced.lastHandledWindow?.startMs ?? null,
      lastBettedWindowStart: synced.lastBettedWindowStart,
    });

    // 启动时检查一次重置条件。
    safeSync("startup_reset", () => applyResetIfNeeded(synced), undefined);
  }

  let paused = false;

  while (true) {
    const pause = safeSync("read_pause", () => readPause(), undefined);
    if (pause === undefined) {
      // 暂停标记都读不了时按暂停处理：宁可少做一轮，也不在摸不清运维意图时下单。
      await sleep(5_000);
      continue;
    }
    if (pause) {
      if (!paused) {
        logEvent("pause", { reason: pause.reason, at: pause.at }, "warn");
        paused = true;
      }
      await sleep(1_000);
      continue;
    }
    if (paused) {
      logEvent("resume", {});
      paused = false;
    }

    const now = Date.now();
    const window = await safeAsync(
      "resolve_window",
      async () => (await currentWindow(now)) ?? (await nextWindow(now)),
      null,
    );
    if (!window) {
      logEvent("window_missing", { retryAfterMs: 1_000 }, "warn");
      await sleep(1_000);
      continue;
    }

    const entryAt = window.startMs + config.timing.entryDelayS * 1000;
    const entryDeadline = entryAt + config.timing.entryWindowS * 1000;

    // 已经错过当前窗口：等它结束 + 2s，直接进入下一窗。
    if (Date.now() > entryDeadline) {
      const reason =
        `错过入场时点（开盘 +${config.timing.entryDelayS}s 起 ` +
        `${config.timing.entryWindowS}s 内未能入场）`;
      safeSync(
        "record_missed_bet",
        () => recordNoBet(window, strategy.id, "ENTRY_MISSED", reason),
        undefined,
        { tradeId: tradeIdOf(window) },
      );
      safeSync(
        "mark_handled",
        () => markHandled(window),
        undefined,
        { tradeId: tradeIdOf(window) },
      );
      logEvent(
        "window_missed",
        {
          tradeId: tradeIdOf(window),
          windowStart: window.startMs,
          windowEnd: window.endMs,
          waitMs: Math.max(0, window.endMs - Date.now() + 2_000),
        },
        "warn",
      );
      const waitMs = window.endMs - Date.now() + 2_000;
      if (waitMs > 0) await sleep(waitMs);
      continue;
    }

    logEvent("window_selected", {
      tradeId: tradeIdOf(window),
      windowStart: window.startMs,
      windowEnd: window.endMs,
      marketId: window.marketId,
      topicId: window.topicId,
      tradingStatus: window.tradingStatus,
      phase: now < window.startMs ? "pending" : "open",
    });

    // runRound 内部每步都有兜底；这里再兜一层，防止遗漏的异常冒到主循环外。
    const round = await safeAsync(
      "run_round",
      () => runRound(ctx, window),
      { window, openRecord: null },
      { tradeId: tradeIdOf(window) },
    );

    // 每窗一次补结算机会（链上对账；预算用尽留到下一窗）。
    await safeAsync("catch_up", () => catchUpOnce(wallet), undefined);

    // 收盘盘面自判 + 本窗口入账。
    await safeAsync(
      "settle_after_close",
      () => settleAfterClose(round),
      undefined,
      { tradeId: tradeIdOf(window) },
    );

    // 结算完成后再检查是否需要重新初始化账本。
    safeSync("reset_check", () => applyResetIfNeeded(readState()), undefined, {
      tradeId: tradeIdOf(window),
    });

    const rest = window.endMs - Date.now() + 2_000;
    if (rest > 0) await sleep(rest);
  }
}
