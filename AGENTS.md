## 项目约束

- 只支持 `btc-15m` 盘口与 `B0` 策略，不再保留多档位 / 多策略扩展。
- **单文件不超过 400 行**。
- 对外时间一律使用 UTC ISO（日志 `ts`、CLI 展示），内部计算可用毫秒时间戳。
- 交易流水按 UTC 日期分文件：`data/trades/YYYY-MM-DD_trades.ndjson`；所有查询只读「昨天 + 今天」。

## 编码规范

### TypeScript / ESM

- 项目是 ESM + `module: NodeNext`：**相对导入必须写 `.js` 后缀**，即使源文件是 `.ts`（例如 `import { config } from "../config/env.js"`）。
- `verbatimModuleSyntax` 开启：只导入类型时用 `import type { ... }`。
- 开着 `strict`、`noUnusedLocals`、`noUnusedParameters`、`noUncheckedIndexedAccess`；不要用 `any` 绕过类型检查。
- 标识符用英文，面向用户的日志 / 文案用中文。

### 依赖与 IO

- **不引入币安 SDK**，也不要为了一个小功能引入新依赖；现有唯一运行时依赖是 `bignumber.js`。
- IO 只出现在 `binance/*`、`engine/*`、`cli/*`、`market/window.ts`；策略与资金管理保持纯函数。
- 结算、指标、日志属于旁路能力：失败时记录并继续，不能影响下单主流程。
- 主循环按步骤兜底：`run` / `runRound` 的每个步骤都用 `safeSync` / `safeAsync` 包住，失败记带 `scope` 的 `error` 日志并跳过本轮；只有启动阶段（钱包 / 支付账户）失败才直接退出。

### 日志

- 唯一日志出口是 `logEvent(event, fields, level)`：单行 JSON、UTC ISO、必带 `event`。
- 与某一笔交易相关的事件必须带 `tradeId = ${marketId}-${windowStart}`，便于按 `tradeId` 还原事件时序。
- 事件名与字段见 `docs/LOGGING.md`；不要新增自由文本日志。
- 未下注必须落一条带 `skipCode` 的流水；原因码从 `SkipCode` 枚举取。
- 金额 / 价格 / 倍率 / 盈亏一律用十进制字符串。

### CLI

- CLI 入口可以直接用顶层 `await`；只读工具做完后用 `process.exit(0)` 结束。
- CLI 的屏幕输出可以用 `console.log`（不是运行日志）；执行器的运行日志必须走 `logEvent`。
- 新增 CLI 命令时：在 `src/cli/` 建入口 → 在 `package.json` 加脚本 → 在 README 命令表登记。

### 注释

- 注释解释「为什么」和口径（例如为什么 `placeOrder` 不重试、为什么先落流水），不要复述代码。
- 与现有风格一致：文件头用块注释概述职责，关键分支用单行注释点明约束。

---

## 运行时序

- `run`：获取单实例锁 → wallet → 选余额最多的支付账户 → `catchUpOnce` → 用流水校正 state → 检查 Reset → `while (true)`。
- 主循环：暂停 → 取窗口 → 错过窗口等待到结束 +2s → `runRound` → `catchUpOnce` → `settleAfterClose` → `applyResetIfNeeded` → 等窗口结束 +2s。
- `runRound`：上一窗口结果 → 只查 B0 选中的方向 → 深度均价 / 倍率门槛 → 注额 → 下单。
- `catchUpOnce` 只做链上对账，不做盘面推导。
