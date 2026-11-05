# btc-prediction-trader-next

币安预测盘 **BTC 15 分钟涨跌** 自动交易机器人。重构后只保留：

- 盘口：`btc-15m`；
- 策略：`B0`（跟盘 + 马丁格尔注码）；
- 日志：单行 JSON、UTC ISO 时间、每条都有 `event`；
- 流水：按 UTC 日期分文件，位于独立目录 `data/trades/YYYY-MM-DD_trades.ndjson`。

> ⚠️ 实盘会真的花钱。这是赌博型策略，不保证盈利，也不是投资建议。

---

## 快速开始

```bash
pnpm install
cp .env.example .env      # 填入 BINANCE_API_KEY / BINANCE_API_SECRET

pnpm doctor               # 只读自检：网络 / 时钟 / Key / 钱包 / 余额
pnpm board                # 当前（或下一个）窗口的实时盘面
pnpm status               # 执行器状态（读 data/，不碰网络）
pnpm trade quote          # 只报价，不下单（默认 1 USDT）

pnpm live                 # ⚠️ 实盘

pnpm pause "手动暂停"
pnpm resume
pnpm notice --check       # 飞书通知自检（只查配置）
pnpm notice "测试消息"     # 真发一条到飞书

pnpm test
pnpm typecheck
```

运行环境：**Node >= 22.12**（`process.loadEnvFile`、原生 fetch）。pnpm 9 / 11 均兼容。

---

## 命令一览

| 命令 | 作用 | 是否动钱 |
|---|---|---|
| `pnpm live` | 启动实盘执行器 | ✅ |
| `pnpm doctor` | 只读自检 | ❌ |
| `pnpm board` | 打印盘面、盘口深度、上一窗口结果 | ❌ |
| `pnpm account` | 钱包 / 余额 / 配额 / 持仓 | ❌ |
| `pnpm status` | 状态、统计、最近流水（昨日+今日） | ❌ |
| `pnpm trade quote [USDT] [UP\|DOWN]` | 只报价 | ❌ |
| `pnpm trade buy <USDT> [UP\|DOWN]` | 真实下单 | ✅ |
| `pnpm trade orders` | 当前挂单 | ❌ |
| `pnpm trade settled [N]` | 已结算记录 | ❌ |
| `pnpm pause [原因]` / `pnpm resume` | 暂停 / 恢复 | ❌ |
| `pnpm notice [文本]` | 发一条飞书通知（默认是链路自检文案） | ❌ |
| `pnpm notice --check` | 只检查飞书凭据是否齐全 | ❌ |

---

## 目录结构

```text
src/
├── domain.ts                  共享领域类型
├── config/
│   ├── market.ts              btc-15m 固定常量
│   └── env.ts                 读取 .env、集中校验配置
├── binance/
│   ├── http.ts                签名请求 + 公开请求 + 服务器时间校正
│   ├── marketApi.ts           市场列表 / 窗口详情 / 盘口
│   ├── accountApi.ts          钱包 / 余额 / 配额 / 持仓 / 结算历史
│   ├── tradeApi.ts            报价 / 下单 / 订单回查
│   └── spotApi.ts             现货顶档与服务器时间
├── market/
│   ├── window.ts              窗口发现（market-list.json 缓存）
│   ├── orderBook.ts           卖一价与盘口深度
│   └── result.ts              输赢判定、涨跌幅、派彩口径
├── strategy/
│   ├── b0.ts                  策略 B0（跟盘）
│   ├── money.ts               马丁格尔资金管理
│   ├── depthStake.ts          按深度算均价与注额
│   └── types.ts               策略契约
├── engine/
│   ├── runner.ts              启动 + 主循环
│   ├── instanceLock.ts        单实例锁（防重复启动执行器）
│   ├── round.ts               一个窗口的决策编排
│   ├── placeBet.ts            下单与落盘
│   ├── roundSupport.ts        等待 / 收口 / 成交校验
│   ├── trading.ts             下单路径与终态确认
│   ├── settlement/
│   │   ├── panel.ts           收盘盘面自判与入账
│   │   ├── ledger.ts          账本、待复核、空单收口
│   │   └── catchup.ts         链上对账（catchUpOnce）
│   ├── stateStore.ts          state.json 原子读写
│   ├── stateSync.ts           启动时用流水校正 state
│   ├── tradeLog.ts            data/trades/YYYY-MM-DD_trades.ndjson
│   ├── reset.ts               账本重新初始化
│   ├── funding.ts             选择余额最多的支付账户
│   ├── notify.ts              用户通知（飞书自建应用直发）
│   ├── metrics.ts / pause.ts  指标 / 暂停标记
├── cli/                       各命令入口
└── util/
    ├── decimal.ts             bignumber.js 唯一入口
    ├── log.ts                 结构化 JSON 日志
    ├── time.ts                UTC ISO / 日期键
    ├── dataDir.ts             数据目录
    └── async.ts               睡眠、预算、重试
```

运行时产物都在 `data/`（已 gitignore）：

| 文件 | 内容 |
|---|---|
| `state.json` | 账本、统计、上一窗口结果、防重放标记 |
| `trades/YYYY-MM-DD_trades.ndjson` | 每回合一行（UTC 日期分文件，独立目录便于归档） |
| `market-list.json` | market/list 的本地缓存 |
| `metrics.json` | 决策 / 下单 / 结算 / 待复核计数器 |
| `PAUSED` | 暂停标记（存在即暂停） |
| `engine.lock` | 单实例锁（记录 PID；进程异常退出后下次启动会自动清理） |

---

## 运行流程

### run

1. 获取单实例锁（`data/engine.lock`；已有存活实例则直接退出）；
2. 获取 wallet；
3. `balance/payment-options` 选出**可用余额最多的已启用账户**，整场复用；
4. 调一次 `catchUpOnce`（只做链上对账）；
5. 根据「昨天 + 今天」的流水校正 `state`；
6. 检查是否触发账本 Reset；
7. `while (true)`：
   - 暂停标记 → 睡 1s；
   - 取当前/下一个窗口，没有则 1s 后重试；
   - 错过入场 → 等本窗口结束 + 2s；
   - `runRound` → `catchUpOnce` → `settleAfterClose` → `applyResetIfNeeded`；
   - 等本窗口结束 + 2s，进入下一轮。

主循环按步骤兜底：`run` / `runRound` 的每个步骤都用 `safeSync` / `safeAsync` 包住，失败只记一条带 `scope` 的 `error` 日志并跳过本轮；只有启动阶段（钱包 / 支付账户）失败才退出进程。

### runRound

1. `resolveLastHandledWindow`（补判上一窗口结果）；
2. `sleepUntil(entryAt)`；
3. 超时校验；
4. 当前窗口已下单校验（state + 未结流水）；
5. 刷新窗口直到 `tradingStatus === "OPEN"`，或超过下单时间限制；
6. `createTradeRecord`；
7. 取上一窗口结算结果：查不到 / DRAW → 本轮跳过；
8. B0 定方向，**只查询要买的那一侧**盘口；查询失败 / 无卖单 → 跳过；
9. 按盘口深度算可成交均价与有效倍率：有效倍率 < 1.3 → 跳过并 `notify`；
10. 推算注额；深度接不下 → warn + `notify`，**仍然下单**；
11. `submitOrder`；
12. 流水落盘、状态更新。

---

## 交易流水与日志

### 日志（stdout）

- 只输出单行 JSON，不再有文本模式；
- `ts` 固定为 **UTC ISO**；
- 每条日志都有 `event`；
- 与某笔交易相关的事件都带 `tradeId = ${marketId}-${windowStart}`。

按 `tradeId` 过滤即可还原一笔交易的完整事件时序：

```bash
pnpm live | grep '"tradeId":"123456-1762300800000"'
```

事件清单与字段见 [docs/LOGGING.md](docs/LOGGING.md)。

### 流水（data/）

- 文件：`data/trades/YYYY-MM-DD_trades.ndjson`（UTC 日期）；
- 查询统一读「昨天 + 今天」两个文件，避免单文件无限增长；
- 终态回填只重写命中的那一天文件（原子替换）。

---

## 通知（飞书）

执行器把重要事件直接推到飞书会话，不依赖 Hermes 或任何第三方网关。

| 事件 | 时机 | 去重 |
|---|---|---|
| ❌ 下单失败 | 下单报错 / 回查终态为 FAILED | 按窗口，不重复 |
| ⚠️ 下单未确认 | 20s 内拿不到终态（按「可能已成交」处理） | 按窗口，不重复 |
| 🔄 重新初始化 | 连败 / 欠账触顶，账本清零 | 按重置次数 |
| ⏸ / ▶️ 暂停 / 恢复 | 主循环发现暂停标记出现 / 消失 | 各一条 |
| ⚠️ 倍率不足 / 深度不足 | 本轮跳过或可能吃不满 | 30 分钟内同类只发一条 |

配置写在 `.env`（见 [.env.example](.env.example)）：

```bash
FEISHU_API_BASE=https://open.feishu.cn/open-apis   # Lark 国际版用 open.larksuite.com
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
FEISHU_RECEIVE_ID=oc_xxxxxxxx
FEISHU_RECEIVE_ID_TYPE=chat_id
```

设计约束：

- **旁路能力**：发送失败只记 `notice_failed`，不抛错、不阻塞交易；进程退出也不影响已发出的消息；
- **凭据可选**：三项都不填 → 通知静默，交易与只读命令照常运行；只填一半 → 启动报错；
- **串行发送**：所有消息走一条队列，避免并发取 token / 触发飞书限流；
- **去重**：同一 `key` 在 `FEISHU_DEDUPE_MS`（默认 30 分钟）内只发一次，防止每 15 分钟刷同一类跳过原因；
- token 缓存 2 小时，提前 5 分钟续期，失效码（99991661/99991663/99991664/99991668）自动清缓存重取。

验证链路：

```bash
pnpm notice --check
pnpm notice "🔧 测试"
```

---

## 关键口径

| 项 | 口径 |
|---|---|
| 数学 | 价格 / 金额 / 倍率 / 盈亏都用 `bignumber.js`，不经过浮点中间计算 |
| 倍率 | 按**盘口深度**算可成交均价；有效倍率 = `(1 − 费率) / 可成交均价` |
| 倍率门槛 | 有效倍率 **< `MIN_EFFECTIVE_MULTIPLIER`（默认 1.3）不下单** |
| 下单 | `MARKET` + `FOK`；每窗口只提交一次、不重试；下单返回 `orderId` ≠ 成交，必须回查终态 |
| 落盘时机 | 拿到 `orderId` 立即写 PENDING 流水 + `lastBettedWindowStart` |
| 成交查询不到 | 按「可能已成交」处理，绝不重试下单 |
| 结算 | 收盘后用手上的 `topicId` 直查盘面，比较开盘价 / 到期价 |
| 平局 | 到期价 = 开盘价 → 每份派彩 0.5 |
| 补结算 | 只做链上对账（`settled-history`），不做盘面推导 |
| 拿不到结果 | 挂 `REVIEW`，不猜、不停机 |
| 风控 | 连败 / 欠账触顶 → 重新初始化账本，不停机、不动累计盈亏 |

---

## 配置

全部配置项见 [.env.example](.env.example)，都有默认值。常用项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ENTRY_DELAY_S` | `30` | 开盘后多少秒入场 |
| `ENTRY_WINDOW_S` | `60` | 入场时点后多久内仍可尝试 |
| `JUDGE_DELAY_S` | `1` | 收盘后多少秒开始自判 |
| `FEE_RATE` | `0.02` | 手续费率 |
| `MIN_EFFECTIVE_MULTIPLIER` | `1.3` | 有效倍率门槛 |
| `B0_BASE_PRICE` | `1` | 基础注码 |
| `B0_RISK_AMOUNT` / `B0_RISK_COUNT` | `10` / `3` | 进入保守模式的阈值 |
| `B0_RESET_LOSS_STREAK` | `15` | 连败多少次清账 |
| `B0_RESET_LOSS_MULTIPLE` | `128` | 欠账达到 `基础注码 × 该值` 清账 |
| `SLIPPAGE_BPS` | `200` | 报价滑点容忍 |
| `DATA_DIR` | `data` | 状态目录 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_RECEIVE_ID` | 空 | 飞书通知凭据；三项都不填则通知静默 |
| `FEISHU_DEDUPE_MS` | `1800000` | 同一通知的冷却时间（30 分钟） |

---

## 测试

```bash
pnpm test        # 资金公式、深度注码、B0 决策、结果判定
pnpm typecheck
```

策略与资金管理是纯函数，测试不依赖网络和 API Key。
