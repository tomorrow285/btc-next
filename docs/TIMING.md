# 运行时序（按事件整理）

本文按 `run` / `runRound` 的代码执行顺序，把运行日志事件排成时间线，并给出有显式时间约束的**开始时间**与**最晚截止时间**。

日志事件字段见 [LOGGING.md](LOGGING.md)；本文只回答「什么时候会看到什么事件」。

---

## 1. 时间基准

设 **T = 当前窗口开盘时刻**（`window.startMs`），`W` = 窗口时长（btc-15m 为 900s）。未进入窗口生命周期的启动事件不套 `T+n`。

| 符号 | 公式 | 取值（`.env.example`） | 代码位置 |
|---|---|---|---|
| `entryAt` | `T + ENTRY_DELAY_S` | T+20s | [round.ts:56](../src/engine/round.ts#L56) |
| `entryDeadline` | `T + ENTRY_DELAY_S + ENTRY_WINDOW_S` | T+60s | [round.ts:57](../src/engine/round.ts#L57) |
| `resolveDeadline` | `entryAt − ORDER_RESERVE_S` | T+15s | [round.ts:64](../src/engine/round.ts#L64) |
| `settleAt` | `T + W + JUDGE_DELAY_S` | T+901s | [panel.ts:195](../src/engine/settlement/panel.ts#L195) |
| `judgeDeadline` | `min(now + JUDGE_BUDGET_S, T + W + ENTRY_DELAY_S − ORDER_RESERVE_S)` | 最早 T+901 起算，通常 T+911s；硬顶 T+915s | [panel.ts:209-213](../src/engine/settlement/panel.ts#L209-L213) |
| `loopResume` | `T + W + 2s` | T+902s | [runner.ts:213](../src/engine/runner.ts#L213) |

### 1.1 相关配置

| 环境变量 | `.env.example` | 作用 |
|---|---|---|
| `ENTRY_DELAY_S` | 20 | 开盘后多少秒入场 |
| `ENTRY_WINDOW_S` | 40 | 入场时点之后多久放弃本局 |
| `ORDER_RESERVE_S` | 5 | 入场前预留给下单路径的时间 |
| `JUDGE_DELAY_S` | 1 | 收盘后多久开始盘面自判 |
| `JUDGE_BUDGET_S` | 10 | 自判读盘面的重试预算 |
| `RECONCILE_BUDGET_S` | 30 | 单次链上对账的总预算 |
| `CHAIN_QUERY_TIMEOUT_S` | 20 | 单笔链上结算记录的等待上限 |
| `CATCHUP_MAX_TRIES` | 2 | 同一笔注的最大补齐次数 |
| `ORDER_CONFIRM_TIMEOUT_MS` | 20_000 | 下单后回查终态的轮询上限（每 700ms 一次） |

> 下表时间均按 `.env.example` 的取值写。若改了环境变量，把 `T+20 / T+60 / T+901 / T+911 / T+915 / T+920` 按上面的公式换算即可。
>
> 注意：`src/config/env.ts` 里的代码兜底值仍是旧口径（`ENTRY_DELAY_S=30`、`ENTRY_WINDOW_S=60`、`JUDGE_BUDGET_S=20`、`RECONCILE_BUDGET_S=60`、`CATCHUP_MAX_TRIES=20`）。只有把 `.env.example` 复制为 `.env` 后，本文的 T+n 才成立。

### 1.2 一窗口速览

```text
T+0          开盘
T+15         resolveDeadline     —— 上一窗口结果补判的最后时刻
T+20         entryAt             —— 睡到这个点，开始决策/下单
T+60         entryDeadline       —— 入场窗口关闭，之后一律不下单
T+901        settleAt            —— 收盘 + JUDGE_DELAY_S，开始盘面自判
T+911        judgeDeadline       —— 通常的自判截止（硬顶 T+915）
T+915        resolveDeadline(下一轮)
T+920        entryAt(下一轮)
```

---

## 2. 启动阶段（`run` 内，进入主循环之前）

启动阶段没有兜底：`list_wallets` / `select_funding_account` 失败会记 `error(fatal=true)` 并向上抛，最终由 CLI 记 `fatal` 后退出。

| # | 相对时刻 | 事件 | 触发条件 / 说明 |
|---|---|---|---|
| 1 | 进程启动 | `cli_start` | `src/cli/run.ts` 顶层，进入 `run()` 之前 |
| 2 | `run()` 第一步 | `engine_lock_acquired` | 拿到单实例锁；已有存活执行器时记 `engine_lock_failed` 并退出；清理过期锁记 `engine_lock_stale_removed` |
| 3 | 锁之后 | `error`（`scope=list_wallets`, `fatal=true`） | 拉钱包失败 → `fatal` → 进程退出 |
| 4 | 钱包之后 | `error`（`scope=select_funding_account`, `fatal=true`） | 选支付账户失败 → `fatal` → 进程退出 |
| 5 | 自检完成 | `startup` | 记录钱包、支付账户、市场、策略与全部 timing 参数 |
| 6 | `startup` 之后 | `catchup_attempt` / `catchup_incomplete` / `catchup_budget_exhausted` / `settlement`(source=chain) / `void` / `review` | `startup_catchup`：只做链上对账；整体失败记 `error(scope=startup_catchup)`，不退出 |
| 7 | 对账之后 | `state_synced` | 用流水校正 state；失败记 `error(scope=sync_state)` 并跳过 |
| 8 | `state_synced` 之后 | `reset` | 启动时连败/欠账触顶会重置账本；失败记 `error(scope=startup_reset)` |
| 9 | 主循环退出时 | `engine_lock_released` | `run()` 的 `finally` 中释放锁 |

> 启动阶段的链上对账会处理所有 `windowEnd <= now` 的未结流水，与窗口 `T+n` 无关。

---

## 3. 单窗口主循环（`run` + `runRound`，按时间顺序）

`round_start` 之前的事件属于「本轮可能还没有流水」的阶段；`round_start` 之后每个分支都会以 `round_skipped`（带 `code`）或 `trade_placed` 收口。

| # | 阶段 | 开始时间 | 最晚截止 | 事件 | 触发条件 / 说明 |
|---|---|---|---|---|---|
| 1 | 循环入口 | 任意 | — | `pause` / `resume` | 读暂停标记；读失败按暂停处理并 `sleep 5s`，暂停中每 1s 轮询 |
| 2 | 取窗口 | 任意 | — | `market_list_cache_hit` / `market_list_refreshed` / `market_list_missing` / `timeline_not_covered` | 解析时间表：优先用缓存锚点，失效时重新拉 `market/list`；`market_list_missing` / `timeline_not_covered` 为 error 级 |
| 3 | 取窗口失败 | 任意 | — | `window_missing` | 时间表没有可用窗口，1s 后重试；`error(scope=resolve_window)` 走同一分支 |
| 4 | 取窗口成功 | 正常约 T+1~11（上一窗口结算后） | — | `window_selected` | 选中当前窗口（`phase=open`）或下一窗口（`phase=pending`） |
| 5 | 错过入场（主循环层） | `now > entryDeadline` | T+902（`window_missed.waitMs`） | `round_skipped`(code=`ENTRY_MISSED`) + `window_missed` | 只有重启/卡顿导致取窗口时已过 T+60 才会走这里；随后等到窗口结束 +2s |
| 6 | `runRound` 第 1 步 | `runRound` 开始 | **T+15**（`resolveDeadline`） | `judge_wait` / `window_result`(`recovered=true`) / `window_result_missing` | 补判上一窗口结果；失败每 5s 重试，超过 T+15 放弃；`error(scope=resolve_last_window)` 不影响本轮 |
| 7 | 等待入场点 | — | **T+20**（`entryAt`） | （无事件，`sleepUntil`） | 早于 T+20 进入时在这里睡到入场点 |
| 8 | 超时校验 | `now > entryDeadline` | **T+60**（`entryDeadline`） | `round_skipped`(code=`ENTRY_MISSED`) + `mark_handled` | 此时还没有 `round_start`；不建回合流水 |
| 9 | 读取状态 | T+20 之后 | — | `error`（`scope=read_state`） | 读 state 失败直接结束本轮，**不落 `round_skipped`** |
| 10 | 查未结流水 | 同上 | — | `error`（`scope=open_trade_lookup`） | 流水读取失败时保守放弃，防重复下单，**不落 `round_skipped`** |
| 11 | 已下注校验 | 同上 | — | `round_skipped`(code=`ALREADY_BET`) | `lastBettedWindowStart` 命中本窗口，或已存在同窗口未结流水（后者带 `hasOpenBet=true`） |
| 12 | 刷新窗口 | T+20 | **T+60**（`entryDeadline`） | `window_refresh` → 截止后 `round_skipped`(code=`TRADING_CLOSED`) | 状态非 `OPEN` 时每 ≤1s 刷新一次；查询异常记 `error(scope=refresh_window_query)` 并继续轮询 |
| 13 | 建回合流水 | 窗口 `OPEN` 后 | — | `round_start` | 含 `previousOutcome` / `previousChangePct`；`error(scope=create_record)` 时本轮直接结束 |
| 14 | 上一窗口结果 | `round_start` 之后 | — | `round_skipped`(code=`PREVIOUS_UNAVAILABLE` / `PREVIOUS_DRAW`) | 查不到上一窗口结果或结果为 DRAW，主动跳过 |
| 15 | 策略决策 | 同上 | — | `decision` → 必要时 `round_skipped`(code=`DECIDE_SKIP`) | `decision.action=SKIP` 时跳过；决策异常记 `error(scope=strategy_decide)` |
| 16 | 读盘口 | 决策 `BUY` 之后 | — | `book` / `round_skipped`(code=`BOOK_ERROR` / `NO_ASK`) | 只查要买的那一侧；无卖单直接跳过 |
| 17 | 深度与门槛 | 读到卖盘之后 | — | `depth_plan` / `round_skipped`(code=`NO_DEPTH` / `MULTIPLE_BELOW_GATE`) / `depth_shortfall`(warn) | 有效倍率不足 → 跳过并 `notify`；深度不足 → 只告警 + `notify`，**不拦截下单** |
| 18 | 提交订单 | 通过门槛之后 | —（无显式截止） | `trade_persisted` | `place-order` 返回 `orderId` 后**立即落 PENDING 流水**，早于终态确认 |
| 19 | 订单终态 | 报价/下单/确认 | 确认开始后 +20s | `order`(status=`FILLED` / `UNKNOWN` / `FAILED` / `ERROR`) | `quote → place(FOK) → confirm`；confirm 每 700ms 轮询，超时按 `UNKNOWN`（不重试） |
| 20 | 成交校验与收口 | 订单返回之后 | — | `fill_check` → `trade_placed`（或 `round_skipped`(code=`ORDER_FAILED` / `ORDER_VOID`)） | 校验实际均价、补亏比例，只告警不拦截 |
| 21 | 链上对账 | `runRound` 返回后（约 T+20~60） | 本次调用预算 30s（`RECONCILE_BUDGET_S`） | `catchup_attempt` / `catchup_incomplete` / `catchup_budget_exhausted` / `settlement`(source=`chain`, `late=true`) / `void` / `review` | 只处理 `windowEnd <= now` 的未结单；单笔最多等 20s，最多尝试 2 次 |
| 22 | 等待收盘 | `catchUpOnce` 之后 | **T+901**（`settleAt`） | `settlement_wait` | 未到 `settleAt` 才记录并睡到 T+901；已过则不记录，直接自判 |
| 23 | 盘面自判 | **T+901**（`settleAt`） | **T+911**（默认 `judgeDeadline`；硬顶 T+915） | `judge_wait` | 价格未就绪每 5s 重试；`deadline = min(now+10s, 下一轮 entryAt−5s)` |
| 24 | 记录结果 | 自判成功 | 同上 | `window_result` → `window_judged` | 无论本窗口是否下注都会记录，供下一轮策略使用 |
| 25 | 入账 | `window_judged` 之后 | — | `settlement`(source=`panel`) / `review` / `window_result_missing` | 有未结单且有成交凭据 → 入账；凭据不足 → REVIEW；预算内拿不到盘面 → REVIEW + 下一轮补判 |
| 26 | 重置检查 | 结算之后 | — | `reset` | 连败/欠账触顶时重置账本（不动累计已实现盈亏） |
| 27 | 进入下一轮 | `settleAfterClose` 之后 | **T+902**（`loopResume`） | （无事件，`sleep(rest)`） | `rest = window.endMs − now + 2s`；通常结算已超过该时刻，`rest <= 0` 不等待 |

### 3.1 正常下单轮的事件序列

```text
window_selected
→ round_start → decision → book → depth_plan
→ trade_persisted → order(FILLED/UNKNOWN) → fill_check → trade_placed
→ settlement_wait
→ judge_wait… → window_result → window_judged
→ settlement(panel) / review
→ reset（若触发）
```

### 3.2 跳过轮的事件序列

```text
window_selected
→ [round_start]
→ round_skipped(code=...)
```

错过入场（还没进入 `runRound` 的完整流程）：

```text
window_selected / window_missed → round_skipped(code=ENTRY_MISSED)
```

---

## 4. 时间约束小结

| 约束 | 开始 | 最晚截止 | 超时后果 |
|---|---|---|---|
| 补判上一窗口 | `round_start` 之前 | **T+15** | 放弃补判，本轮继续（不影响入场） |
| 等待入场 | `runRound` 开始 | **T+20** | 不可能超时（`sleepUntil` 只睡不抛） |
| 入场/下单时间窗 | T+20 | **T+60** | `ENTRY_MISSED`（主循环）或 `TRADING_CLOSED`（窗口不 OPEN） |
| 刷新窗口至 `OPEN` | T+20 | **T+60** | `TRADING_CLOSED` |
| 订单终态确认 | `place-order` 返回后 | 确认开始 +20s | 按 `UNKNOWN` 处理，交结算/补齐兜底（绝不重试） |
| 链上对账 | `runRound` 后 | 单次调用 30s；单笔 20s | `catchup_budget_exhausted` / `catchup_incomplete`，留到下一次 |
| 收盘盘面自判 | **T+901** | **T+911**（硬顶 T+915） | `window_result_missing`；有单则挂 `REVIEW`，下一轮补判 |
| 进入下一轮 | 结算后 | **T+902**（`sleep` 目标） | 无；若结算已超时则立即进入下一轮 |

> **隐式约束**：`submitOrder` 本身没有检查 `entryDeadline`。报价/下单/确认的网络耗时可能让订单路径越过 T+60，但最多受 `ORDER_CONFIRM_TIMEOUT_MS`（20s）约束；因此实际下单时刻不严格等于「T+60 之前」。

---

## 5. 兜底与缺失事件说明

- `run` / `runRound` 的每一步都由 `safeSync` / `safeAsync` 包裹；失败统一记 `error`（带 `scope`）后按兜底值继续，只有启动阶段（`list_wallets` / `select_funding_account`）是 `fatal`。
- 以下分支**只记 `error`，不落 `round_skipped`**：`read_state`、`open_trade_lookup`、`create_record`、`finish_record`（落盘失败时）、`record_no_bet`、`mark_handled`。
- 策略/盘口计算异常仍会收口成空单：`strategy_decide`、`compute_gates` → `DECIDE_SKIP`；`plan_stake` → `NO_DEPTH`；这两种情况都会落 `round_skipped`。
- 最外层还有 `safeAsync("run_round", ...)` 兜底，防止遗漏的异常冒到主循环；此时本轮没有 `round_skipped`，只看到 `error(scope=run_round)`。
- `catch_up`、`settle_after_close`、`reset_check` 属于旁路能力：失败记 `error(scope=catch_up / settle_after_close / reset_check)`，不影响下一窗口入场。
- 按 `tradeId` 复盘时，跳过轮看 `round_skipped`，成交轮看 `trade_persisted → order → trade_placed`，结算看 `settlement` 的 `source`（`panel` = 盘面快路径，`chain` = 链上对账）。
