/**
 * 涨跌盘窗口的发现与解析（只有 btc-15m）。
 *
 * 链路：
 *   market/list   → 找到 slug 形如 btc-updown-15m-* 的锚点 topic
 *   market/detail → 该 topic 的 timeline[]，覆盖未来约 12 小时的全部窗口
 *   market/detail → 按窗口自己的 marketTopicId 取 marketId / outcomes / 开盘价 / 到期价
 *
 * market/list 的结果会持久化到 `data/market-list.json`：
 * 下次优先从缓存里找锚点，只有缓存缺失或锚点失效时才重新请求接口。
 */
import fs from "node:fs";

import type {
  MarketDetail,
  MarketTopic,
  Outcome,
  TimelineEntry,
} from "../binance/marketApi.js";
import { listMarketTopics, marketDetail } from "../binance/marketApi.js";
import { config } from "../config/env.js";
import { MARKET } from "../config/market.js";
import { dataPath, ensureDataDir } from "../util/dataDir.js";
import { logEvent } from "../util/log.js";

export interface PredictionWindow {
  topicId: number;
  marketId: number;
  startMs: number;
  endMs: number;
  /** 只有 OPEN 才允许下单。 */
  tradingStatus: string;
  settled: boolean;
  /** 目标价（开盘基准价）。开盘前为 null。 */
  openPrice: string | null;
  endPrice: string | null;
  up: Outcome | undefined;
  down: Outcome | undefined;
  participantCount: number;
  volume: number;
  liquidity: number;
}

interface Anchor {
  topicId: number;
  timeline: TimelineEntry[];
}

interface MarketListCache {
  fetchedAt: number;
  topics: MarketTopic[];
}

const MARKET_LIST_PATH = dataPath("market-list.json");
let anchor: Anchor | null = null;

export function tradeIdOf(
  target: { marketId: number; startMs: number } | { marketId: number; windowStart: number },
): string {
  const start = "startMs" in target ? target.startMs : target.windowStart;
  return `${target.marketId}-${start}`;
}

function coversNow(timeline: TimelineEntry[], now = Date.now()): boolean {
  return (
    timeline.some((entry) => entry.startDate <= now && now < entry.endDate) ||
    timeline.some((entry) => entry.startDate > now)
  );
}

function readMarketListCache(): MarketTopic[] | null {
  try {
    if (!fs.existsSync(MARKET_LIST_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(MARKET_LIST_PATH, "utf8")) as Partial<MarketListCache>;
    return Array.isArray(parsed.topics) && parsed.topics.length > 0 ? parsed.topics : null;
  } catch {
    return null;
  }
}

function writeMarketListCache(topics: MarketTopic[]): void {
  if (topics.length === 0) return;
  try {
    ensureDataDir();
    const temporary = `${MARKET_LIST_PATH}.tmp`;
    const payload: MarketListCache = { fetchedAt: Date.now(), topics };
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, "utf8");
    fs.renameSync(temporary, MARKET_LIST_PATH);
  } catch {
    // 缓存写失败不影响交易，下一次重新请求即可
  }
}

function anchorOf(topics: readonly MarketTopic[]): MarketTopic | undefined {
  return topics.find((topic) => topic.slug.startsWith(MARKET.slugPrefix));
}

/** 逐页翻 market/list 找锚点；结果整体写入本地缓存。 */
async function fetchMarketTopics(): Promise<MarketTopic[]> {
  const { listPageSize, listMaxPages } = config.market;
  const all: MarketTopic[] = [];

  for (let page = 0; page < listMaxPages; page++) {
    const topics = await listMarketTopics(listPageSize, page * listPageSize);
    all.push(...topics);
    if (anchorOf(topics)) break;
  }

  writeMarketListCache(all);
  return all;
}

/** 优先读缓存；force 或缓存里找不到锚点时重新请求 market/list。 */
async function discoverAnchorTopicId(force = false): Promise<number> {
  if (!force) {
    const cached = readMarketListCache();
    const hit = cached ? anchorOf(cached) : undefined;
    if (hit) {
      logEvent("market_list_cache_hit", {
        anchorTopicId: hit.marketTopicId,
        cachedTopics: cached?.length ?? 0,
      });
      return hit.marketTopicId;
    }
  }

  const topics = await fetchMarketTopics();
  const fresh = anchorOf(topics);
  if (fresh) {
    logEvent("market_list_refreshed", {
      anchorTopicId: fresh.marketTopicId,
      topics: topics.length,
      forced: force,
    });
    return fresh.marketTopicId;
  }

  logEvent("market_list_missing", {
    pages: config.market.listMaxPages,
    prefix: MARKET.slugPrefix,
  }, "error");
  throw new Error(`market/list 前 ${config.market.listMaxPages} 页里找不到 ${MARKET.slugPrefix}* 事件`);
}

async function loadTimeline(topicId: number): Promise<TimelineEntry[]> {
  return (await marketDetail(topicId)).timeline ?? [];
}

async function getTimeline(forceFreshList = false): Promise<TimelineEntry[]> {
  // 已记住锚点：先直查它的时间表（它承载滚动时间表，与列表排序无关）。
  if (anchor) {
    try {
      const timeline = await loadTimeline(anchor.topicId);
      if (coversNow(timeline)) {
        anchor = { topicId: anchor.topicId, timeline };
        return timeline;
      }
    } catch {
      // 锚点查询失败 → 重新发现
    }
  }

  let topicId = await discoverAnchorTopicId(forceFreshList);
  let timeline = await loadTimeline(topicId);

  // 缓存里的锚点可能已经失效：强制拉一次 market/list 再试。
  if (!coversNow(timeline) && !forceFreshList) {
    topicId = await discoverAnchorTopicId(true);
    timeline = await loadTimeline(topicId);
  }

  if (!coversNow(timeline)) {
    logEvent("timeline_not_covered", {
      anchorTopicId: topicId,
      entries: timeline.length,
    }, "error");
    throw new Error(`锚点 topic ${topicId} 的时间表没覆盖当前时刻（${timeline.length} 条）`);
  }
  anchor = { topicId, timeline };
  return timeline;
}

/** 时间表可能过期：未命中时强制刷新一次再找。 */
async function findEntry(
  predicate: (entry: TimelineEntry) => boolean,
): Promise<TimelineEntry | null> {
  const hit = (await getTimeline()).find(predicate);
  if (hit) return hit;

  anchor = null;
  return (await getTimeline(true)).find(predicate) ?? null;
}

function detailToWindow(topicId: number, detail: MarketDetail): PredictionWindow {
  const market = detail.markets?.[0];
  if (!market) throw new Error(`窗口 ${topicId} 没有 market`);

  const outcomesByName = new Map(
    (market.outcomes ?? []).map((outcome) => [outcome.name.toLowerCase(), outcome]),
  );

  return {
    topicId,
    marketId: market.marketId,
    startMs: detail.startDate,
    endMs: detail.endDate,
    tradingStatus: market.tradingStatus,
    settled: market.settled,
    openPrice: detail.variantData?.startPrice ?? null,
    endPrice: detail.variantData?.endPrice ?? null,
    up: outcomesByName.get("up"),
    down: outcomesByName.get("down"),
    participantCount: detail.participantCount,
    volume: market.tradeVolume,
    liquidity: market.liquidity,
  };
}

async function toWindow(entry: TimelineEntry): Promise<PredictionWindow> {
  return detailToWindow(entry.marketTopicId, await marketDetail(entry.marketTopicId));
}

/** 按开盘时刻解析窗口；不在时间表内返回 null。 */
export async function resolveWindow(startMs: number): Promise<PredictionWindow | null> {
  const entry = await findEntry((item) => item.startDate === startMs);
  return entry ? toWindow(entry) : null;
}

/** 当前正在进行的窗口（已开盘、未结束）。 */
export async function currentWindow(now: number = Date.now()): Promise<PredictionWindow | null> {
  const entry = await findEntry((item) => item.startDate <= now && now < item.endDate);
  return entry ? toWindow(entry) : null;
}

/** 下一个尚未开盘的窗口。 */
export async function nextWindow(now: number = Date.now()): Promise<PredictionWindow | null> {
  const entry = await findEntry((item) => item.startDate > now);
  return entry ? toWindow(entry) : null;
}

/**
 * 按 topicId 直查窗口 —— 结算必须走这条。
 *
 * 窗口一收盘就从时间表里消失，按开盘时刻反查必然得到 null；
 * 手里的 topicId 直查 market/detail 才能拿到 endPrice。
 */
export async function windowByTopicId(topicId: number): Promise<PredictionWindow> {
  return detailToWindow(topicId, await marketDetail(topicId));
}
