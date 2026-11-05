/** 异步小工具：睡眠、时间预算、重试。 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 时间预算耗尽。它表示「这次没空做」，不代表操作失败。 */
export class BudgetError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}超出时间预算（${Math.round(ms)}ms）`);
    this.name = "BudgetError";
  }
}

export function isBudgetError(error: unknown): error is BudgetError {
  return error instanceof BudgetError;
}

/** 给一个 Promise 套上调用方侧的死线。底层请求可以继续跑完，读接口是幂等的。 */
export function withBudget<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms)) return promise;
  if (ms <= 0) return Promise.reject(new BudgetError(label, ms));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
