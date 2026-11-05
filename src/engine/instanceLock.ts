/**
 * 单实例锁：同一个 DATA_DIR 下只允许一个实盘执行器。
 *
 * 用 `wx` 独占创建锁文件；若已存在，检查文件里的 PID 是否还活着：
 *   - 活着 → 拒绝启动，避免两个引擎对同一窗口重复下单；
 *   - 已退出 → 视为上一次异常退出留下的陈旧锁，删除后重试一次。
 *
 * SIGKILL / 断电不会执行清理逻辑，所以启动时必须以 PID 存活状态为准，
 * 不能只依赖正常退出时的删除。
 */
import fs from "node:fs";

import { dataPath, ensureDataDir } from "../util/dataDir.js";
import { logEvent } from "../util/log.js";

const LOCK_PATH = dataPath("engine.lock");

interface LockOwner {
  pid: number;
  startedAt: number;
}

export interface InstanceLock {
  release: () => void;
}

function readOwner(): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/** 保守判断：只有明确的 ESRCH 才认为进程不存在，其余未知情况一律按存活处理。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function release(owner: LockOwner): void {
  try {
    const current = readOwner();
    // 只删除属于自己的锁：避免退出时误删新进程刚创建的锁文件。
    if (current?.pid === owner.pid && current.startedAt === owner.startedAt) {
      fs.rmSync(LOCK_PATH, { force: true });
      logEvent("engine_lock_released", { pid: owner.pid });
    }
  } catch {
    // 退出路径不能因为清理锁失败而抛错
  }
}

export function acquireInstanceLock(): InstanceLock {
  ensureDataDir();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      const owner: LockOwner = { pid: process.pid, startedAt: Date.now() };
      try {
        fs.writeSync(fd, `${JSON.stringify(owner)}\n`, null, "utf8");
      } finally {
        fs.closeSync(fd);
      }

      logEvent("engine_lock_acquired", { pid: owner.pid, path: LOCK_PATH });
      return { release: () => release(owner) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const owner = readOwner();
      if (owner && isProcessAlive(owner.pid)) {
        const message =
          `另一个执行器正在运行（pid=${owner.pid}，锁文件 ${LOCK_PATH}）；` +
          "如确认该进程已停止，请删除锁文件后重试";
        logEvent("engine_lock_failed", { pid: owner.pid, path: LOCK_PATH, attempt }, "error");
        throw new Error(message);
      }

      logEvent("engine_lock_stale_removed", { pid: owner?.pid ?? null, path: LOCK_PATH }, "warn");
      fs.rmSync(LOCK_PATH, { force: true });
    }
  }

  throw new Error(`无法获取执行器单实例锁：${LOCK_PATH}`);
}
