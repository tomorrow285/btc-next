/**
 * 运行指标（计数器）。落在 `data/metrics.json`，供 status 与外部监控读取。
 *
 * 指标写入永远不能影响交易：读写失败时静默跳过。
 */
import fs from "node:fs";

import { dataPath, ensureDataDir } from "../util/dataDir.js";

export const METRICS_PATH = dataPath("metrics.json");

export type MetricKey =
  | "decisionsBuy"
  | "decisionsSkip"
  | "ordersFilled"
  | "ordersUnknown"
  | "ordersFailed"
  | "settlements"
  | "settlementsPanel"
  | "settlementsChain"
  | "reviewsOpened"
  | "reviewsResolved";

export type RuntimeMetrics = Record<MetricKey, number> & { updatedAt: number };

const ZERO: Omit<RuntimeMetrics, "updatedAt"> = {
  decisionsBuy: 0,
  decisionsSkip: 0,
  ordersFilled: 0,
  ordersUnknown: 0,
  ordersFailed: 0,
  settlements: 0,
  settlementsPanel: 0,
  settlementsChain: 0,
  reviewsOpened: 0,
  reviewsResolved: 0,
};

export function readMetrics(): RuntimeMetrics {
  ensureDataDir();
  if (!fs.existsSync(METRICS_PATH)) {
    return { ...ZERO, updatedAt: Date.now() };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(METRICS_PATH, "utf8")) as Partial<RuntimeMetrics>;
    return {
      ...ZERO,
      ...parsed,
      updatedAt: parsed.updatedAt ?? Date.now(),
    };
  } catch {
    return { ...ZERO, updatedAt: Date.now() };
  }
}

export function addMetrics(delta: Partial<Record<MetricKey, number>>): void {
  try {
    const current = readMetrics();
    const next: RuntimeMetrics = { ...current, updatedAt: Date.now() };
    for (const [key, value] of Object.entries(delta) as Array<[MetricKey, number]>) {
      next[key] = (next[key] ?? 0) + value;
    }

    ensureDataDir();
    const temporary = `${METRICS_PATH}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, METRICS_PATH);
  } catch {
    // 指标是旁路，不能影响交易
  }
}
