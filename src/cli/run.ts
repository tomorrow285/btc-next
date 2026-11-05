#!/usr/bin/env node
/**
 * 实盘执行器入口。
 *
 *   pnpm live
 *
 * ⚠️ 会真的花钱。所有参数见 .env.example。
 */
import { config } from "../config/env.js";
import { run } from "../engine/runner.js";
import { errorText, logEvent } from "../util/log.js";

logEvent("cli_start", {
  mode: "live",
  market: config.market.id,
  strategy: config.strategy.kind,
  entryDelayS: config.timing.entryDelayS,
});

try {
  await run();
} catch (error) {
  // 走到这里只可能是启动阶段失败（主循环内的步骤已逐级兜底）。
  logEvent("fatal", { message: errorText(error) }, "error");
  process.exit(1);
}
