/**
 * 用户通知 · 飞书自建应用直发会话。
 *
 * 链路：tenant_access_token → im/v1/messages（text）。
 *
 * 约束：
 *   - 旁路能力：任何失败只记 `notice_failed`，不抛错、不阻塞交易主流程；
 *   - 调用方默认 fire-and-forget；需要「发完再退出」的 CLI 用 `await notify(...)`；
 *   - 串行发送：并发取 token / 并发打飞书容易触发限流，队列化最省心；
 *   - 同一去重键在 `FEISHU_DEDUPE_MS` 内只发一次：每 15 分钟一轮的同类跳过
 *     不该把人手机刷爆，但「换了个原因」仍然会照常推。
 *
 * 未配置凭据时整体静默：只读命令（board/status）不应该因为缺通知配置启动失败。
 */
import { config } from "../config/env.js";
import { sleep } from "../util/async.js";
import { errorText, logEvent } from "../util/log.js";

const TOKEN_PATH = "/auth/v3/tenant_access_token/internal";
const MESSAGE_PATH = "/im/v1/messages";

/** token 有效期 2h，提前 5 分钟续期，避免卡在过期边界上。 */
const TOKEN_REFRESH_AHEAD_MS = 5 * 60_000;
/** 积压上限：通知再重要也不能让交易进程无限占内存。 */
const MAX_PENDING = 50;
/** 飞书「token 无效 / 过期」类错误码：清缓存，下一轮重新取。 */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991664, 99991668]);

interface FeishuResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
  data?: { message_id?: string };
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export interface NoticeOptions {
  /**
   * 去重键。默认用完整文案。
   * 同类可重复的事件（例如「有效倍率不足」）应传稳定键，避免每次数值不同就重发。
   */
  key?: string;
}

let cachedToken: CachedToken | null = null;
let pending = 0;
/** 发送串行链：永远处于 resolved 状态，避免一次失败卡死后续消息。 */
let chain: Promise<unknown> = Promise.resolve();
const lastSentAt = new Map<string, number>();

/**
 * 推送一条通知。
 *
 * 返回是否真的发出去（未启用 / 冷却中 / 队列满时是 false）。
 * 交易主流程可以直接忽略返回值；CLI 自检可以 await 它拿到结果。
 */
export function notify(
  message: string,
  fields: Record<string, unknown> = {},
  options: NoticeOptions = {},
): Promise<boolean> {
  if (!config.feishu.enabled) return Promise.resolve(false);

  const text = message.trim();
  if (!text) return Promise.resolve(false);

  const key = options.key ?? text;
  const now = Date.now();
  const last = lastSentAt.get(key);
  if (last !== undefined && now - last < config.feishu.dedupeMs) {
    logEvent("notice_suppressed", { ...fields, key, reason: "dedupe" });
    return Promise.resolve(false);
  }

  if (pending >= MAX_PENDING) {
    logEvent("notice_dropped", { ...fields, key, reason: "queue_full" }, "warn");
    return Promise.resolve(false);
  }

  prune(now);
  lastSentAt.set(key, now);
  pending += 1;

  const result = chain
    .then(() => deliver(text, fields))
    .finally(() => {
      pending -= 1;
    });

  // deliver 内部已兜底；这里再收一次，保证调用方忽略返回值时不会 unhandledRejection。
  chain = result.catch(() => false);
  return result;
}

async function deliver(text: string, fields: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= config.feishu.retries; attempt += 1) {
    try {
      const messageId = await sendText(text);
      logEvent("notice_sent", { ...fields, messageId, attempts: attempt });
      return true;
    } catch (error) {
      const failure = errorText(error);
      const isLast = attempt >= config.feishu.retries;
      logEvent(
        "notice_failed",
        {
          ...fields,
          attempt,
          attempts: config.feishu.retries,
          deliveryError: failure,
          text: truncate(text),
        },
        isLast ? "error" : "warn",
      );
      if (isLast) return false;
      await sleep(1_000 * attempt);
    }
  }
  return false;
}

async function sendText(text: string): Promise<string> {
  const token = await tenantToken();
  const url =
    `${config.feishu.apiBase}${MESSAGE_PATH}` +
    `?receive_id_type=${encodeURIComponent(config.feishu.receiveIdType)}`;
  const body = await postJson(
    url,
    {
      receive_id: config.feishu.receiveId,
      msg_type: "text",
      // 飞书要求 content 是「JSON 字符串」，不是嵌套对象。
      content: JSON.stringify({ text }),
    },
    token,
  );

  if (body.code !== 0) {
    if (body.code !== undefined && TOKEN_INVALID_CODES.has(body.code)) cachedToken = null;
    throw new Error(`飞书发送失败 code=${body.code ?? "?"} msg=${body.msg ?? ""}`);
  }
  return body.data?.message_id ?? "";
}

async function tenantToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const body = await postJson(`${config.feishu.apiBase}${TOKEN_PATH}`, {
    app_id: config.feishu.appId,
    app_secret: config.feishu.appSecret,
  });

  const value = body.tenant_access_token;
  if (body.code !== 0 || !value) {
    throw new Error(`飞书取 tenant_access_token 失败 code=${body.code ?? "?"} msg=${body.msg ?? ""}`);
  }

  const expireS = Number(body.expire ?? 7200);
  cachedToken = {
    value,
    expiresAt: Date.now() + Math.max(60_000, expireS * 1000 - TOKEN_REFRESH_AHEAD_MS),
  };
  return value;
}

async function postJson(
  url: string,
  payload: Record<string, unknown>,
  accessToken?: string,
): Promise<FeishuResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.feishu.timeoutMs),
  });

  const raw = await response.text();
  let parsed: FeishuResponse;
  try {
    parsed = JSON.parse(raw) as FeishuResponse;
  } catch {
    throw new Error(`飞书接口返回非 JSON（HTTP ${response.status}）：${raw.slice(0, 200)}`);
  }

  // 飞书业务错误通常仍是 HTTP 200 + code != 0；HTTP 层失败则多半没有 code。
  if (!response.ok && parsed.code === undefined) {
    throw new Error(`飞书接口 HTTP ${response.status}：${raw.slice(0, 200)}`);
  }
  return parsed;
}

function prune(now: number): void {
  if (lastSentAt.size < 200) return;
  for (const [key, at] of lastSentAt) {
    if (now - at >= config.feishu.dedupeMs) lastSentAt.delete(key);
  }
}

function truncate(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
