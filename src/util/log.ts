/**
 * 结构化日志（唯一的日志出口）。
 *
 * 每行必须是一个 JSON 对象，必须带 `event`，时间固定为 UTC ISO。
 * 与某一笔交易相关的事件请带上 `tradeId`（= `${marketId}-${windowStart}`），
 * 事后按 `tradeId` 过滤即可还原这笔交易的完整事件时序。
 */
import { utcIso } from "./time.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

/** 写一行 JSON 日志。调用方不要再往 fields 里放 ts / level / event。 */
export function logEvent(event: string, fields: LogFields = {}, level: LogLevel = "info"): void {
  process.stdout.write(`${JSON.stringify({ ts: utcIso(), level, event, ...fields })}\n`);
}

/** 统一的错误描述，避免各层各写一遍。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
