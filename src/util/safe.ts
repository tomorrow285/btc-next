/**
 * 主循环的步骤级兜底。
 *
 * 执行器的每个步骤失败都不应该让整个进程退出：记一条带 scope 的 error 日志，
 * 然后返回调用方给的兜底值继续下一轮。真正无法继续的步骤（启动阶段）由调用方
 * 显式选择重新抛出。
 */
import { errorText, logEvent, type LogFields } from "./log.js";

/** 同步步骤：失败记日志并按 fallback 继续。 */
export function safeSync<T, F>(
  scope: string,
  fn: () => T,
  fallback: F,
  fields: LogFields = {},
): T | F {
  try {
    return fn();
  } catch (error) {
    logEvent("error", { scope, message: errorText(error), ...fields }, "error");
    return fallback;
  }
}

/** 异步步骤：失败记日志并按 fallback 继续。 */
export async function safeAsync<T, F>(
  scope: string,
  fn: () => Promise<T>,
  fallback: F,
  fields: LogFields = {},
): Promise<T | F> {
  try {
    return await fn();
  } catch (error) {
    logEvent("error", { scope, message: errorText(error), ...fields }, "error");
    return fallback;
  }
}
