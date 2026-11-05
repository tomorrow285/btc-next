/** 币安现货公开行情：顶档报价与服务器时间。仅用于看盘与时钟校准。 */
import { config } from "../config/env.js";
import { dec, decimal } from "../util/decimal.js";

export interface TopOfBook {
  bid: string;
  ask: string;
  mid: string;
}

export async function topOfBook(symbol: string = config.market.spotSymbol): Promise<TopOfBook> {
  const response = await fetch(
    `${config.binance.baseUrl}/api/v3/ticker/bookTicker?symbol=${symbol}`,
    {
      headers: { "user-agent": config.binance.userAgent },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`现货 bookTicker HTTP ${response.status}`);

  const data = (await response.json()) as { bidPrice: string; askPrice: string };
  const bid = decimal(data.bidPrice);
  const ask = decimal(data.askPrice);
  return { bid, ask, mid: dec(bid).plus(ask).div(2).toFixed() };
}

/** 币安服务器时间与本机时间的偏差（毫秒，正数 = 本机慢）。 */
export async function serverTimeOffset(): Promise<number> {
  const startedAt = Date.now();
  const response = await fetch(`${config.binance.baseUrl}/api/v3/time`, {
    headers: { "user-agent": config.binance.userAgent },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`现货 time HTTP ${response.status}`);

  const finishedAt = Date.now();
  const data = (await response.json()) as { serverTime: number };
  return data.serverTime - (startedAt + finishedAt) / 2;
}
