/** 人工暂停标记：存在即暂停。执行器只读，只有运维脚本会写/删。 */
import fs from "node:fs";

import { dataPath, ensureDataDir } from "../util/dataDir.js";

export const PAUSE_PATH = dataPath("PAUSED");

export interface PauseInfo {
  at: number;
  reason: string;
  realizedPnl?: string;
  totalLoss?: string;
}

export function readPause(): PauseInfo | null {
  ensureDataDir();
  if (!fs.existsSync(PAUSE_PATH)) return null;

  try {
    return JSON.parse(fs.readFileSync(PAUSE_PATH, "utf8")) as PauseInfo;
  } catch {
    return { at: Date.now(), reason: "（暂停标记无法解析）" };
  }
}

export function setPause(info: PauseInfo): void {
  ensureDataDir();
  fs.writeFileSync(PAUSE_PATH, `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

export function clearPause(): void {
  if (fs.existsSync(PAUSE_PATH)) fs.rmSync(PAUSE_PATH);
}
