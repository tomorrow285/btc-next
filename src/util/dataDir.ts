/** 运行数据目录（state / 流水 / 缓存 / 暂停标记）。 */
import fs from "node:fs";
import path from "node:path";

import { config } from "../config/env.js";

export const DATA_DIR = config.dataDir;

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function dataPath(...parts: string[]): string {
  return path.join(DATA_DIR, ...parts);
}
