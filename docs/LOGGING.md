# 日志与交易流水

本项目只有两种「日志」：

| 层 | 载体 | 格式 | 用途 |
|---|---|---|---|
| 运行日志 | stdout | 单行 JSON，UTC ISO，必带 `event` | 实时观察、告警、按 `event` / `tradeId` 复盘 |
| 交易流水 | `data/trades/YYYY-MM-DD_trades.ndjson` | 单行 JSON，按 UTC 日期分文件 | 账本审计、重启恢复、`pnpm status` |

没有文本日志模式，也没有 `LOG_FORMAT` / `LOG_TIMEZONE` 配置。

---

## 1. 运行日志

每条日志的形状：

```json
{"ts":"2026-11-05T05:30:00.123Z","level":"info","event":"decision","tradeId":"123456-1762300800000","action":"BUY","side":"UP"}
```

- `ts`：UTC ISO（`Date.prototype.toISOString()`）。
- `level`：`info` / `warn` / `error`。
- `event`：事件名，必填。
- 交易相关事件都带 `tradeId = ${marketId}-${windowStart}`。

### 1.1 事件清单

| `event` | 级别 | 触发点 | 关键字段 |
|---|---|---|---|
| `cli_start` | info | `pnpm live` 启动 | `mode` `market` `strategy` `entryDelayS` |
| `engine_lock_acquired` | info | 启动时拿到单实例锁 | `pid` `path` |
| `engine_lock_failed` | error | 已有存活执行器，拒绝启动 | `pid` `path` `attempt` |
| `engine_lock_stale_removed` | warn | 清理上一次异常退出留下的锁 | `pid` `path` |
| `engine_lock_released` | info | 正常退出时释放锁 | `pid` |
| `startup` | info | 执行器完成自检 | `wallet` `funding` `market` `strategy` `entryDelayS` `judgeDelayS` `feeRate` `minEffectiveMultiplier` |
| `state_synced` | info | 启动时用流水校正 state | `realizedPnl` `totalLoss` `lossStreak` `bets` `reviewOpen` `lastBettedWindowStart` |
| `reset` | info | 连败 / 欠账触顶 | `reason` `totalLossBefore` `lossStreakBefore` `realizedPnl` `resets` |
| `pause` / `resume` | warn / info | 暂停标记出现 / 消失 | `reason` `at` |
| `window_missing` | warn | 时间表里没有可用窗口 | `retryAfterMs` |
| `window_selected` | info | 主循环选中窗口 | `tradeId` `windowStart` `windowEnd` `marketId` `topicId` `tradingStatus` |
| `window_missed` | warn | 已错过入场时点 | `tradeId` `windowStart` `windowEnd` `waitMs` |
| `round_start` | info | 回合开始、已建流水 | `tradeId` `windowStart` `previousOutcome` `previousChangePct` |
| `window_refresh` | warn | `tradingStatus` 不是 OPEN，继续刷新 | `windowStart` `tradingStatus` `remainingMs` |
| `round_skipped` | warn | **本轮不下注的统一事件**（错过入场 / 已下注 / 非 OPEN / 查不到上盘 / DRAW / 盘口失败 / 无卖单 / 无深度 / 倍率不足 / 下单失败） | `tradeId` `windowStart` `marketId` `code` `reason` `status` `side` |
| `market_list_cache_hit` | info | 使用 `market-list.json` 缓存里的锚点 | `anchorTopicId` `cachedTopics` |
| `market_list_refreshed` | info | 重新请求 market/list | `anchorTopicId` `topics` `forced` |
| `market_list_missing` | error | market/list 里找不到锚点 | `pages` `prefix` |
| `timeline_not_covered` | error | 锚点时间表没覆盖当前时刻 | `anchorTopicId` `entries` |
| `decision` | info | B0 给出 BUY / SKIP | `tradeId` `action` `side` `reason` `previousOutcome` |
| `book` | info | 要买方向的盘口读取成功 | `tradeId` `side` `ask` `askLevels` |
| `depth_plan` | info | 按深度算完均价 / 倍率 / 注额 | `baseExecPrice` `execPrice` `gateQuotedMultiple` `gateEffectiveMultiple` `quotedMultiple` `effectiveMultiple` `amountUsdt` `capacityUsdt` `depthShortfall` |
| `depth_shortfall` | warn | 深度接不下计划注额 | `tradeId` `side` `capacityUsdt` `amountUsdt` |
| `order` | info / warn / error | 下单路径各终态（每窗口只提交一次，不重试） | `tradeId` `status` `stage` `orderId` `filledUsdt` `filledShares` `error` |
| `trade_persisted` | info | 拿到 `orderId` 后落 PENDING 流水 | `tradeId` `orderId` `amountUsdt` |
| `fill_check` | info / warn | 成交后校验均价 / 补亏比例 | `tradeId` `avgFillPrice` `fillDriftBps` `recoveryRatio` `warning` |
| `trade_placed` | info | 本窗口下单完成 | `tradeId` `orderId` `status` `side` `amountUsdt` |
| `catchup_attempt` | info | 链上对账单条未结记录 | `tradeId` `status` `tries` |
| `catchup_incomplete` | warn | 本次对账未拿到链上结算 | `tradeId` `marketId` `message` |
| `catchup_budget_exhausted` | warn | 对账预算用尽 | `message` |
| `settlement_wait` | info | 下单后等待收盘（长休眠） | `tradeId` `windowStart` `windowEnd` `settleAt` `waitMs` `hasOpenRecord` |
| `judge_wait` | info | 盘面价格未就绪，5s 后重试 | `tradeId` `marketId` `topicId` `attempt` `remainingMs` `reason` |
| `window_result` | info | 收盘盘面判定完成 | `tradeId` `windowStart` `outcome` `openPrice` `endPrice` `changePct` |
| `window_judged` | info | 本窗口收盘判定完成 | `tradeId` `outcome` `changePct` `result` |
| `window_result_missing` | warn | 预算内拿不到盘面结果 | `tradeId` / `marketId` `windowStart` |
| `settlement` | info | 一笔注入账 | `tradeId` `source` `late` `outcome` `pnl` `totalLoss` `lossStreak` |
| `review` | warn | 证据不足，转待复核 | `tradeId` `marketId` `reason` |
| `void` | info | 订单历史确认未成交 | `tradeId` `orderId` `reason` `tries` |
| `error` | error / warn | 内部错误；主循环步骤兜底也走这里 | `scope` `message` `fatal`（仅启动阶段） |
| `fatal` | error | 启动阶段失败，进程即将退出 | `message` |
| `notice_sent` | info | 飞书通知发送成功 | `messageId` `attempts` + 调用方字段 |
| `notice_failed` | warn / error | 单次发送失败 / 重试耗尽（error） | `attempt` `attempts` `deliveryError` `text` |
| `notice_suppressed` | info | 同一去重键还在冷却期，本次不发 | `key` `reason` |
| `notice_dropped` | warn | 通知积压超过上限，丢弃 | `key` `reason` |
| `board_error` | warn | `pnpm board --watch` 刷新失败 | `message` |

### 1.2 `order` 事件的子状态

| `status` | 含义 |
|---|---|
| `FILLED` | 回查到终态且已成交 |
| `UNKNOWN` | 终态未确认，按「可能已成交」处理，**不重试** |
| `FAILED` | 下单失败，未产生持仓 |
| `ERROR` | 下单报错（不重试），正在回查订单历史 |

`stage` 取值：`quote`（报价）/ `place`（下单）/ `confirm`（回查终态），用于定位失败发生在哪一步。

`recoveredFromHistory: true` 表示下单报错后从订单历史回查到已受理的单。

---

## 2. 交易流水

### 2.1 文件

`data/trades/YYYY-MM-DD_trades.ndjson`，日期取**写入时刻的 UTC 日期**。

- 查询统一读「昨天 + 今天」两个文件；
- 终态回填只重写命中的那一天文件（临时文件 + rename）；
- 单行损坏会被跳过，不影响同一天其它记录。

### 2.2 字段

| 组 | 字段 |
|---|---|
| 标识与时间 | `ts` `windowStart` `windowEnd` `marketId` `topicId` `strategy` |
| 决策 | `status` `side` `reason` `skipCode` |
| 盘口与注码 | `askPrice` `execPrice` `depthCapacityUsdt` `quotedMultiple` `amountUsdt` `totalLossBefore` |
| 订单与成交 | `orderId` `filledUsdt` `filledShares` `feeShares` |
| 成交后校验 | `avgFillPrice` `fillDriftBps` `winPnlIfWin` `recoveryRatio` `warning` |
| 上一窗口 | `previousSide` `previousChangePct` |
| 结算 | `resultSide` `settleValuePerShare` `pnl` `resultSource` `resolvedLate` `resolvedAt` `catchUpTries` |
| 账本快照 | `totalLossAfter` `realizedPnlAfter` |
| 错误 | `error` |

### 2.3 `status` 状态机

| 状态 | 含义 |
|---|---|
| `SKIP` | 本轮未下注 |
| `PENDING` | 已下单，等待结算（可能已成交、也可能未知） |
| `REVIEW` | 证据不足，等待补齐 |
| `SETTLED` | 已入账 |
| `FAILED` | 下单失败，没产生持仓 |
| `VOID` | 订单历史确认未成交，一分钱没花 |
| `ERROR` | 反复补齐失败，需要人工核对 |

### 2.4 `skipCode` 空单原因码

| 原因码 | 含义 |
|---|---|
| `ALREADY_BET` | 本窗口已下过注 |
| `TRADING_CLOSED` | 下单时间限制内窗口始终不是 OPEN |
| `BOOK_ERROR` | 盘口读取失败 |
| `NO_ASK` | 选定方向没有卖单 |
| `NO_DEPTH` | 连基础注码都接不下 |
| `PREVIOUS_UNAVAILABLE` | 查不到上一窗口结算结果 |
| `PREVIOUS_DRAW` | 上一窗口平局 |
| `DECIDE_SKIP` | 策略明确跳过 |
| `MULTIPLE_BELOW_GATE` | 有效倍率低于门槛 |
| `ENTRY_MISSED` | 错过入场时点 |
| `ORDER_FAILED` | 下单失败 |
| `ORDER_VOID` | 订单历史确认未成交 |

---

## 3. 按 `tradeId` 复盘一笔交易

`tradeId = ${marketId}-${windowStart}`。在 stdout 日志里过滤：

```bash
pnpm live | grep '"tradeId":"123456-1762300800000"'
```

典型时序：

```text
window_selected → round_start → decision → book → depth_plan
→ trade_persisted → order(FILLED/UNKNOWN) → fill_check → trade_placed
→ settlement_wait → (judge_wait…) → window_result / window_judged
→ settlement（或 review / void）
```

跳过的一轮：

```text
round_start → round_skipped(code=...) 
```

错过入场（还没进入 `runRound` 的完整流程）：

```text
window_selected / window_missed → round_skipped(code=ENTRY_MISSED)
```

重启后补判：

```text
window_result(recovered=true)
catchup_attempt → settlement(source=chain)
```

对应的流水在 `data/trades/YYYY-MM-DD_trades.ndjson` 里只占一行，`status` 会随结算回填。
