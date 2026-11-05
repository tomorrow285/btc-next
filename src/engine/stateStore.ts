/**
 * 执行器状态的持久化。
 *
 * 全部落在 `<DATA_DIR>/` 下：
 *   state.json            单份状态，原子写
 *   trades/YYYY-MM-DD_trades.ndjson  每回合一行（append-only，按 UTC 日期分文件）
 *   PAUSED                暂停标记（存在即暂停）
 *   metrics.json          运行指标
 *   market-list.json      market/list 缓存
 *
 * 金额/价格/盈亏一律以十进制字符串落盘，避免浮点误差。
 */
import fs from "node:fs";

import type { PreviousWindowResult } from "../domain.js";
import { emptyBankroll, type Bankroll } from "../strategy/money.js";
import { decimal } from "../util/decimal.js";
import { dataPath, ensureDataDir } from "../util/dataDir.js";

export const STATE_PATH = dataPath("state.json");

/** 最近一次处理过的窗口。即使没下注也记录，供下一窗口解析结果。 */
export interface HandledWindow {
  startMs: number;
  endMs: number;
  marketId: number;
  topicId: number;
}

export interface EngineState {
  /** 马丁格尔账本。 */
  bankroll: Bankroll;

  startedAt: number;
  rounds: number;
  bets: number;
  wins: number;
  losses: number;
  flats: number;
  /** 累计下注额（含手续费），十进制字符串。 */
  stakedUsdt: string;
  /** 累计已实现盈亏，十进制字符串。只用于对账，不参与风控。 */
  realizedPnl: string;

  /** 重新初始化次数。重置只清账本，不动 realizedPnl。 */
  resets: number;
  lastResetAt: number | null;
  lastResetReason: string | null;

  /** 待复核的注有几笔。 */
  reviewOpen: number;
  /** 累计补齐过多少笔待复核记录。 */
  reviewsResolved: number;

  /** 最近处理过的窗口（下注或跳过都算）。 */
  lastHandledWindow: HandledWindow | null;
  /** 最近一个窗口的判定结果，供下一窗口的策略使用。 */
  lastWindowResult: PreviousWindowResult | null;
  /** 已经下过注的窗口开盘时刻，防重启后重复下单。 */
  lastBettedWindowStart: number | null;

  lastRoundAt: number | null;
  updatedAt: number;
  lastError: string | null;
}

export function createInitialState(): EngineState {
  return {
    bankroll: emptyBankroll(),
    startedAt: Date.now(),
    rounds: 0,
    bets: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    stakedUsdt: "0",
    realizedPnl: "0",
    resets: 0,
    lastResetAt: null,
    lastResetReason: null,
    reviewOpen: 0,
    reviewsResolved: 0,
    lastHandledWindow: null,
    lastWindowResult: null,
    lastBettedWindowStart: null,
    lastRoundAt: null,
    updatedAt: Date.now(),
    lastError: null,
  };
}

export function readState(): EngineState {
  ensureDataDir();
  if (!fs.existsSync(STATE_PATH)) return createInitialState();

  const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<EngineState>;
  const base = createInitialState();

  return {
    ...base,
    ...parsed,
    bankroll: {
      totalLoss: decimal(parsed.bankroll?.totalLoss ?? 0),
      lossStreak: Number(parsed.bankroll?.lossStreak ?? 0),
    },
    stakedUsdt: decimal(parsed.stakedUsdt ?? 0),
    realizedPnl: decimal(parsed.realizedPnl ?? 0),
    startedAt: parsed.startedAt ?? base.startedAt,
    lastWindowResult: parsed.lastWindowResult
      ? {
          ...parsed.lastWindowResult,
          openPrice: decimal(parsed.lastWindowResult.openPrice ?? 0),
          endPrice: decimal(parsed.lastWindowResult.endPrice ?? 0),
          changePct: decimal(parsed.lastWindowResult.changePct ?? 0),
        }
      : null,
  };
}

/** 原子写：先写临时文件再 rename，避免掉电/被杀留下半截 JSON。 */
export function writeState(state: EngineState): void {
  ensureDataDir();
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(temporary, STATE_PATH);
}
