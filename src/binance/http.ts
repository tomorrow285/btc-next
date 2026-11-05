/**
 * 币安 HTTP 基础设施：
 *   - `signedRequest`：SAPI 签名接口（HMAC-SHA256，参数放 query）；
 *   - `publicPost`：预测盘公开接口（web3.binance.com），免签名。
 *
 * 不使用任何官方 SDK。签名规则与币安官方 SDK 行为对齐：
 *   - 参数全部放 query，POST 也一样；
 *   - 签名串 = 原样 key + encodeURIComponent(value)，保持插入顺序，末尾追加 timestamp；
 *   - URL 侧用 URLSearchParams（key/value 都会编码）。
 */
import { createHmac } from "node:crypto";

import { config, requireApiKeys } from "../config/env.js";

interface ApiErrorBody {
  code?: number | string;
  msg?: string;
  message?: string;
}

/** 带币安错误码的异常。message 保留服务端原文，便于上层按文本判断是否可重试。 */
export class ApiError extends Error {
  readonly code: number | string;

  constructor(code: number | string, message: string) {
    super(`${message}（code=${code}）`);
    this.name = "ApiError";
    this.code = code;
  }
}

const serialize = (value: unknown): string =>
  value === null || value === undefined
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

/** 币安签名串：key 不编码，value 编码。顺序必须与 URL 参数顺序一致。 */
function buildSignString(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(serialize(value))}`)
    .join("&");
}

function parseErrorBody(text: string): ApiErrorBody {
  try {
    return JSON.parse(text) as ApiErrorBody;
  } catch {
    return {};
  }
}

function isRetryableError(code: number | string, httpStatus: number): boolean {
  const numeric = Number(code);
  // -1021/-1022：时间窗/签名问题，换新 timestamp 重签有救；5xx/429：服务端临时状况。
  return numeric === -1021 || numeric === -1022 || httpStatus >= 500 || httpStatus === 429;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------- 服务器时间校正 ----------

const CLOCK_CACHE_MS = 5 * 60_000;
let clockOffsetMs = 0;
let clockOffsetAt = 0;

/**
 * 本机时钟与币安服务器时间的偏移（毫秒）。
 * 取不到时沿用旧值（初始 0）—— 校时失败不能拦住下单。
 */
async function serverTimeOffsetMs(): Promise<number> {
  if (clockOffsetAt && Date.now() - clockOffsetAt < CLOCK_CACHE_MS) return clockOffsetMs;

  try {
    const startedAt = Date.now();
    const response = await fetch(`${config.binance.baseUrl}/api/v3/time`, {
      headers: { "user-agent": config.binance.userAgent },
      signal: AbortSignal.timeout(3_000),
    });
    const finishedAt = Date.now();
    const body = (await response.json()) as { serverTime: number };
    clockOffsetMs = body.serverTime - Math.round((startedAt + finishedAt) / 2);
    clockOffsetAt = Date.now();
  } catch {
    // 保持上一次的偏移量
  }
  return clockOffsetMs;
}

// ---------- 签名请求 ----------

export interface SignedRequestOptions {
  /**
   * 失败重试次数（默认取 HTTP_RETRIES）。
   * 只给幂等的读接口用；下单必须显式传 0。
   */
  retry?: number;
}

/**
 * 发起一次签名请求，返回已解析的 JSON body。
 *
 * 时间戳与签名每轮重试都会重算：请求在途滞留超过 recvWindow 时，
 * 拿旧签名重发必然还是 -1021。
 */
export async function signedRequest<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  options: SignedRequestOptions = {},
): Promise<T> {
  const { apiKey, apiSecret } = requireApiKeys();
  const retries = Math.max(0, options.retry ?? config.binance.readRetries);
  const attempts = 1 + retries;
  const offset = await serverTimeOffsetMs();

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const query = { ...params, timestamp: Date.now() + offset };
    const signature = createHmac("sha256", apiSecret)
      .update(buildSignString(query))
      .digest("hex");

    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...query, signature })) {
      if (value !== null && value !== undefined) search.set(key, serialize(value));
    }

    const url = `${config.binance.baseUrl}${path}?${search.toString()}`;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "X-MBX-APIKEY": apiKey,
          "user-agent": config.binance.userAgent,
        },
        signal: AbortSignal.timeout(config.binance.timeoutMs),
      });
      const text = await response.text();

      if (response.ok) return JSON.parse(text) as T;

      const body = parseErrorBody(text);
      const code = body.code ?? response.status;
      const error = new ApiError(code, body.msg ?? body.message ?? text.slice(0, 200));
      if (!isRetryableError(code, response.status)) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // 网络错误 / AbortSignal.timeout 抛出的 TimeoutError
      lastError =
        (error as Error)?.name === "TimeoutError"
          ? new Error(`请求超时（${config.binance.timeoutMs}ms）`)
          : error;
    }

    if (attempt < attempts) await delay(500 * attempt);
  }

  throw lastError;
}

// ---------- 公开接口 ----------

/** 公开接口统一响应包装：code 为字符串 "000000" 才算成功。 */
interface PublicEnvelope<T> {
  code: string;
  message: string | null;
  data: T;
}

/** 调用预测盘公开接口（免登录、免签名、不占 API Key 权重）。 */
export async function publicPost<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${config.prediction.webBaseUrl}/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: config.prediction.webOrigin,
      referer: config.prediction.webReferer,
      "user-agent": config.binance.userAgent,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.binance.timeoutMs),
  });

  if (!response.ok) throw new Error(`预测盘 ${route} HTTP ${response.status}`);

  const envelope = (await response.json()) as PublicEnvelope<T>;
  if (envelope.code !== "000000") {
    throw new Error(`预测盘 ${route} ${envelope.code} ${envelope.message ?? ""}`);
  }
  return envelope.data;
}
