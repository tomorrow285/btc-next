/** 时间格式化：对外一律使用 UTC ISO。 */

/** 毫秒时间戳 → UTC ISO 字符串。 */
export function utcIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

/** 毫秒时间戳 → UTC 日期键 YYYY-MM-DD。 */
export function utcDateKey(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC 日期键偏移（-1 = 昨天）。 */
export function shiftUtcDate(key: string, days: number): string {
  const base = Date.parse(`${key}T00:00:00.000Z`);
  return utcDateKey(base + days * 86_400_000);
}

/** 把毫秒时长格式化成易读文本。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
