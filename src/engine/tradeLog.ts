/**
 * 回合流水（append-only NDJSON，按 UTC 日期分文件）。
 *
 * 目录：`<DATA_DIR>/trades/YYYY-MM-DD_trades.ndjson`，每回合一行，
 * 与 state.json / metrics.json 等运行状态分开存放，便于整目录归档/轮转。
 * 查询约定：只读「昨天 + 今天」两个文件，避免单文件无限增长；
 * 终态回填时只重写命中的那一天文件（原子替换）。
 */
import fs from "node:fs";

import type { Side, StrategyId, WindowOutcome } from "../domain.js";
import type { PredictionWindow } from "../market/window.js";
import { dataPath } from "../util/dataDir.js";
import { shiftUtcDate, utcDateKey } from "../util/time.js";

export type TradeStatus =
  | "SKIP" // 策略没入场 / 行情不满足
  | "PENDING" // 已下单，等待结算（可能已成交、也可能未知）
  | "REVIEW" // 收盘时拿不全证据，等待补齐
  | "SETTLED" // 已入账
  | "FAILED" // 下单失败，没产生持仓
  | "VOID" // 订单历史确认未成交，一分钱没花
  | "ERROR"; // 反复补齐失败，需要人工核对

export type ResultSource = "panel" | "chain" | "order-history";

/**
 * 空单原因码（机器可读）。每一笔没下注的流水都必须带一个，
 * 便于事后按码聚合「为什么这个窗口没做」，而不是翻自由文本。
 */
export type SkipCode =
  | "ALREADY_BET" // 本窗口已下过注（重启防重放）
  | "TRADING_CLOSED" // 下单时间限制内窗口状态始终不是 OPEN
  | "BOOK_ERROR" // 盘口读取失败
  | "NO_ASK" // 选定方向没有卖单
  | "NO_DEPTH" // 连基础注码都接不下
  | "PREVIOUS_UNAVAILABLE" // 查不到上一窗口结算结果
  | "PREVIOUS_DRAW" // 上一窗口平局
  | "DECIDE_SKIP" // 策略明确跳过
  | "MULTIPLE_BELOW_GATE" // 盘口深度折算的有效倍率低于门槛
  | "ENTRY_MISSED" // 错过入场时点 / 入场准备超时
  | "ORDER_FAILED" // 下单失败，没产生持仓
  | "ORDER_VOID"; // 订单历史确认未成交（空单，无盈亏）

export interface TradeRecord {
  ts: number;
  windowStart: number;
  windowEnd: number;
  marketId: number;
  topicId: number;
  strategy: StrategyId;
  status: TradeStatus;
  side: Side | null;
  reason: string;
  /** 空单原因码；下单成功（PENDING/REVIEW/SETTLED）为 null。 */
  skipCode: SkipCode | null;

  /** 下单时的卖一价（仅作对照，注额按可成交均价算）。 */
  askPrice: string | null;
  /** 按计划注额逐档吃单后的可成交均价（十进制字符串） */
  execPrice: string | null;
  /** 可成交档位能承接的 USDT 总量 */
  depthCapacityUsdt: string | null;
  /** 报价倍率 = 1 / 基础注码的可成交均价 */
  quotedMultiple: string | null;
  /** 本注计划下注额（十进制字符串） */
  amountUsdt: string | null;
  /** 下单前的 TOTAL_LOSS，用于核对本注能否补平 */
  totalLossBefore: string | null;

  orderId: string | null;
  filledUsdt: string | null;
  filledShares: string | null;
  feeShares: string | null;

  /** 成交后校验：实际均价、相对计划均价的偏离、若赢可补回多少欠账 */
  avgFillPrice: string | null;
  fillDriftBps: string | null;
  winPnlIfWin: string | null;
  recoveryRatio: string | null;
  warning: string | null;

  /** 决策时使用的上一窗口信息，便于复盘 */
  previousSide: WindowOutcome | null;
  previousChangePct: string | null;

  resultSide: WindowOutcome | null;
  settleValuePerShare: string | null;
  pnl: string | null;
  resultSource: ResultSource | null;
  resolvedLate: boolean | null;
  resolvedAt: number | null;
  catchUpTries: number | null;

  totalLossAfter: string | null;
  realizedPnlAfter: string | null;
  error: string | null;
}

/** 按日流水独立目录，方便与运行状态文件分开归档。 */
export const TRADES_DIR = dataPath("trades");

export function tradeFileName(dateKey: string): string {
  return `${dateKey}_trades.ndjson`;
}

export function tradeFilePath(dateKey: string): string {
  return dataPath("trades", tradeFileName(dateKey));
}

/** 确保流水目录存在（append / 原子回写前都要调用）。 */
export function ensureTradesDir(): void {
  fs.mkdirSync(TRADES_DIR, { recursive: true });
}

/** 查询窗口：昨天 + 今天（UTC）。顺序为从旧到新。 */
export function recentDateKeys(now: number = Date.now()): [string, string] {
  const today = utcDateKey(now);
  return [shiftUtcDate(today, -1), today];
}

export function createTradeRecord(
  window: Pick<PredictionWindow, "startMs" | "endMs" | "marketId" | "topicId">,
  strategy: StrategyId,
): TradeRecord {
  return {
    ts: Date.now(),
    windowStart: window.startMs,
    windowEnd: window.endMs,
    marketId: window.marketId,
    topicId: window.topicId,
    strategy,
    status: "SKIP",
    side: null,
    reason: "",
    skipCode: null,
    askPrice: null,
    execPrice: null,
    depthCapacityUsdt: null,
    quotedMultiple: null,
    amountUsdt: null,
    totalLossBefore: null,
    orderId: null,
    filledUsdt: null,
    filledShares: null,
    feeShares: null,
    avgFillPrice: null,
    fillDriftBps: null,
    winPnlIfWin: null,
    recoveryRatio: null,
    warning: null,
    previousSide: null,
    previousChangePct: null,
    resultSide: null,
    settleValuePerShare: null,
    pnl: null,
    resultSource: null,
    resolvedLate: null,
    resolvedAt: null,
    catchUpTries: null,
    totalLossAfter: null,
    realizedPnlAfter: null,
    error: null,
  };
}

function readFile(dateKey: string): TradeRecord[] {
  const file = tradeFilePath(dateKey);
  if (!fs.existsSync(file)) return [];

  const rows: TradeRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as TradeRecord);
    } catch {
      // 单行损坏不应让整天的流水不可读
    }
  }
  return rows;
}

function writeFile(dateKey: string, rows: readonly TradeRecord[]): void {
  ensureTradesDir();
  const file = tradeFilePath(dateKey);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.renameSync(temporary, file);
}

/** 追加到「今天」的流水文件（按写入时刻的 UTC 日期）。 */
export function appendTrade(record: TradeRecord): void {
  ensureTradesDir();
  fs.appendFileSync(tradeFilePath(utcDateKey(record.ts)), `${JSON.stringify(record)}\n`, "utf8");
}

/** 读取昨天 + 今天的流水（可按需指定日期键）。 */
export function readTrades(dateKeys: readonly string[] = recentDateKeys()): TradeRecord[] {
  ensureTradesDir();
  return dateKeys.flatMap((key) => readFile(key));
}

/**
 * 找到第一条满足条件的记录并回写它所在的当天文件（原子替换）。
 * 先查今天，再查昨天：绝大多数终态回填都发生在当天。
 */
export function updateTrade(
  match: (record: TradeRecord) => boolean,
  patch: Partial<TradeRecord>,
): boolean {
  const [yesterday, today] = recentDateKeys();
  for (const key of [today, yesterday]) {
    const rows = readFile(key);
    const index = rows.findIndex(match);
    const target = index >= 0 ? rows[index] : undefined;
    if (!target) continue;

    Object.assign(target, patch);
    writeFile(key, rows);
    return true;
  }
  return false;
}

export function openTrades(): TradeRecord[] {
  return readTrades().filter(
    (record) => record.status === "PENDING" || record.status === "REVIEW",
  );
}

export function isOpen(record: TradeRecord): boolean {
  return record.status === "PENDING" || record.status === "REVIEW";
}

export function openTradeForMarket(marketId: number): TradeRecord | null {
  return readTrades().find((record) => record.marketId === marketId && isOpen(record)) ?? null;
}
