/**
 * 配置入口：读取 .env / 系统环境变量，集中解析并校验。
 *
 * 约定：
 *   - 所有可调常量都在这里出现一次，业务代码只读 `config.xxx`；
 *   - 项目只支持 btc-15m 盘口与 B0 策略，不再做多档位/多策略的扩展；
 *   - 缺失的变量使用默认值，填了但格式不对则启动即报错（不静默降级）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MARKET } from "./market.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

function findProjectRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

/** 项目根目录（含 package.json 的那一层）。 */
export const ROOT_DIR = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

// Node 内置的 .env 读取（>= 20.12）。没有 .env 是正常情况；
// 有但格式错误时直接抛出，避免静默忽略用户配置。
const envFilePath = path.join(ROOT_DIR, ".env");
if (fs.existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

const NODE_VERSION = process.versions.node;
const [nodeMajor = 0, nodeMinor = 0] = NODE_VERSION.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  throw new Error(`需要 Node >= 22.12，当前 ${NODE_VERSION}`);
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
}

function readRequiredString(name: string, fallback = ""): string {
  return process.env[name]?.trim() ?? fallback;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`环境变量 ${name} 必须是数字，当前值：${raw}`);
  }
  return value;
}

function readInteger(name: string, fallback: number): number {
  const value = readNumber(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`环境变量 ${name} 必须是整数，当前值：${value}`);
  }
  return value;
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (value < min || value > max) {
    throw new Error(`环境变量 ${name} 必须在 [${min}, ${max}] 内，当前值：${value}`);
  }
}

function assertPositive(name: string, value: number): void {
  if (!(value > 0)) throw new Error(`环境变量 ${name} 必须大于 0，当前值：${value}`);
}

function assertNonNegative(name: string, value: number): void {
  if (value < 0) throw new Error(`环境变量 ${name} 不能为负数，当前值：${value}`);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveDataDir(raw: string): string {
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
}

const windowSeconds = MARKET.windowMinutes * 60;

const feeRate = readNumber("FEE_RATE", 0.02);
assertRange("FEE_RATE", feeRate, 0, 0.999);

/** 有效倍率低于该值一律不下单（按盘口深度算出的有效倍率）。 */
const minEffectiveMultiplier = readNumber("MIN_EFFECTIVE_MULTIPLIER", 1.3);
if (!(minEffectiveMultiplier >= 1)) {
  throw new Error("MIN_EFFECTIVE_MULTIPLIER 必须 >= 1");
}

const bBasePrice = readNumber("B0_BASE_PRICE", 1);
assertPositive("B0_BASE_PRICE", bBasePrice);

const bRiskAmount = readNumber("B0_RISK_AMOUNT", 10);
assertNonNegative("B0_RISK_AMOUNT", bRiskAmount);

const bRiskCount = readInteger("B0_RISK_COUNT", 3);
assertNonNegative("B0_RISK_COUNT", bRiskCount);

const bResetLossStreak = readInteger("B0_RESET_LOSS_STREAK", 15);
assertPositive("B0_RESET_LOSS_STREAK", bResetLossStreak);

const bResetLossMultiple = readNumber("B0_RESET_LOSS_MULTIPLE", 128);
assertPositive("B0_RESET_LOSS_MULTIPLE", bResetLossMultiple);

// ---------- 飞书通知 ----------
// 三项凭据要么全填、要么全不填：只填一半通常是复制 .env 时漏了，静默不通知比报错更难查。
const feishuAppId = readRequiredString("FEISHU_APP_ID");
const feishuAppSecret = readRequiredString("FEISHU_APP_SECRET");
const feishuReceiveId = readRequiredString("FEISHU_RECEIVE_ID");
const feishuCredentialCount = [feishuAppId, feishuAppSecret, feishuReceiveId].filter(Boolean).length;
if (feishuCredentialCount > 0 && feishuCredentialCount < 3) {
  throw new Error(
    "飞书通知凭据不完整：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_RECEIVE_ID 必须同时填写",
  );
}

const feishuEnabledRaw = readString("FEISHU_NOTIFY_ENABLED", "true");
if (feishuEnabledRaw !== "true" && feishuEnabledRaw !== "false") {
  throw new Error(`FEISHU_NOTIFY_ENABLED 只能是 true / false，当前值：${feishuEnabledRaw}`);
}
const feishuRetries = readInteger("FEISHU_RETRIES", 3);
assertPositive("FEISHU_RETRIES", feishuRetries);
const feishuDedupeMs = readInteger("FEISHU_DEDUPE_MS", 1_800_000);
assertNonNegative("FEISHU_DEDUPE_MS", feishuDedupeMs);

const slippageBps = readInteger("SLIPPAGE_BPS", 200);
assertRange("SLIPPAGE_BPS", slippageBps, 1, 10_000);

const entryDelayS = readNumber("ENTRY_DELAY_S", 30);
assertNonNegative("ENTRY_DELAY_S", entryDelayS);
const entryWindowS = readNumber("ENTRY_WINDOW_S", 60);
assertPositive("ENTRY_WINDOW_S", entryWindowS);

// 入场必须落在本局窗口内，否则该配置在当前盘口下没有意义。
if (entryDelayS >= windowSeconds) {
  throw new Error(`ENTRY_DELAY_S=${entryDelayS}s 必须小于窗口时长 ${windowSeconds}s`);
}
if (entryDelayS + entryWindowS > windowSeconds) {
  throw new Error(
    `ENTRY_DELAY_S + ENTRY_WINDOW_S=${entryDelayS + entryWindowS}s 不能超过窗口时长 ${windowSeconds}s`,
  );
}

export const config = {
  binance: {
    baseUrl: stripTrailingSlash(readString("BINANCE_BASE_URL", "https://api.binance.com")),
    apiKey: readRequiredString("BINANCE_API_KEY"),
    apiSecret: readRequiredString("BINANCE_API_SECRET"),
    userAgent: readString("USER_AGENT", DEFAULT_USER_AGENT),
    timeoutMs: readInteger("HTTP_TIMEOUT_MS", 20_000),
    /** 幂等读接口失败后的重试次数；下单接口永远传 0。 */
    readRetries: readInteger("HTTP_RETRIES", 2),
  },

  prediction: {
    webBaseUrl: stripTrailingSlash(
      readString(
        "PREDICTION_WEB_BASE",
        "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/prediction/web",
      ),
    ),
    webOrigin: readString("PREDICTION_WEB_ORIGIN", "https://web3.binance.com"),
    webReferer: readString(
      "PREDICTION_WEB_REFERER",
      "https://web3.binance.com/zh-CN/prediction/live",
    ),
    /** order-book 的必填 vendor。 */
    vendor: readString("PREDICTION_VENDOR", "PREDICT_FUN"),
  },

  market: {
    /** 唯一盘口：btc-15m。 */
    id: MARKET.id,
    label: MARKET.label,
    windowMinutes: MARKET.windowMinutes,
    spotSymbol: readString("SPOT_SYMBOL", "BTCUSDT"),
    listPageSize: readInteger("MARKET_LIST_PAGE_SIZE", 100),
    /** 首次找锚点最多翻几页；找到后会持久化 topicId 供下次优先复用。 */
    listMaxPages: readInteger("MARKET_LIST_MAX_PAGES", MARKET.listMaxPages),
  },

  timing: {
    /** 开盘后多少秒入场。 */
    entryDelayS,
    /** 超过入场时点这么久就放弃本局。 */
    entryWindowS,
    /** 收盘后多少秒开始盘面自判（重构后固定为 1s）。 */
    judgeDelayS: readNumber("JUDGE_DELAY_S", 1),
    /** 自判读盘面的重试预算。 */
    judgeBudgetS: readNumber("JUDGE_BUDGET_S", 20),
    /** 入场前留给下单路径的时间。 */
    orderReserveS: readNumber("ORDER_RESERVE_S", 5),
    /** 链上对账单次预算。 */
    reconcileBudgetS: readNumber("RECONCILE_BUDGET_S", 60),
    /** 单笔链上结算记录的等待上限。 */
    chainQueryTimeoutS: readNumber("CHAIN_QUERY_TIMEOUT_S", 20),
    /** 同一笔注的最大补齐尝试次数。 */
    catchUpMaxTries: readInteger("CATCHUP_MAX_TRIES", 20),
  },

  order: {
    slippageBps,
    confirmTimeoutMs: readInteger("ORDER_CONFIRM_TIMEOUT_MS", 20_000),
  },

  strategy: {
    /** 策略标识固定为 B0。 */
    kind: "B0" as const,
    /** 手续费率（按份额扣）。 */
    feeRate,
    /** 有效倍率低于该值就不下单。 */
    minEffectiveMultiplier,

    /** 策略 B0 专属参数（环境变量 B0_*）。 */
    b0: {
      basePrice: bBasePrice,
      riskAmount: bRiskAmount,
      riskCount: bRiskCount,
      resetLossStreak: bResetLossStreak,
      resetLossMultiple: bResetLossMultiple,
    },
  },

  feishu: {
    /** 凭据齐全且没被显式关掉才启用；未启用时 notify() 直接返回，不报错。 */
    enabled: feishuEnabledRaw === "true" && feishuCredentialCount === 3,
    /** 飞书开放平台根地址；Lark 国际版换成 https://open.larksuite.com/open-apis。 */
    apiBase: stripTrailingSlash(readString("FEISHU_API_BASE", "https://open.feishu.cn/open-apis")),
    appId: feishuAppId,
    appSecret: feishuAppSecret,
    receiveId: feishuReceiveId,
    /** chat_id（群）/ open_id / user_id / email，见飞书 im/v1/messages。 */
    receiveIdType: readString("FEISHU_RECEIVE_ID_TYPE", "chat_id"),
    timeoutMs: readInteger("FEISHU_TIMEOUT_MS", 10_000),
    /** 单条消息的发送尝试次数（含首次）。 */
    retries: feishuRetries,
    /** 同一去重键的冷却时间；防止每个窗口重复刷同一类跳过原因。 */
    dedupeMs: feishuDedupeMs,
  },

  dataDir: resolveDataDir(readString("DATA_DIR", "data")),
};

export function requireApiKeys(): { apiKey: string; apiSecret: string } {
  if (!config.binance.apiKey || !config.binance.apiSecret) {
    throw new Error("缺少 BINANCE_API_KEY / BINANCE_API_SECRET，请复制 .env.example 为 .env 并填写");
  }
  return { apiKey: config.binance.apiKey, apiSecret: config.binance.apiSecret };
}
