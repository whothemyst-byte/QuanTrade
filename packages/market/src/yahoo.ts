import { BarSchema, type Bar } from "@quantrade/core";
import type { MarketAdapter, NewsItem } from "./adapter.js";
import { fetchJson } from "./http.js";

/** Yahoo serves identical data from two hosts. Having both lets us survive a
 *  per-host rate limit, which is by far the most common failure here. */
export const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"] as const;
export type YahooHost = (typeof YAHOO_HOSTS)[number];

function toEpoch(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}

/** Yahoo timestamps are the session open instant. Both NSE (03:45 UTC) and
 *  US (13:30/14:30 UTC) open on the same UTC day as their local date, so a
 *  plain UTC slice yields the correct session date for both markets. */
function toISODate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export class YahooAdapter implements MarketAdapter {
  readonly name: string;
  private readonly chart: string;
  private readonly search: string;

  constructor(host: YahooHost = "query1.finance.yahoo.com") {
    this.name = `yahoo:${host.split(".")[0]}`;
    this.chart = `https://${host}/v8/finance/chart`;
    this.search = `https://${host}/v1/finance/search`;
  }

  async dailyBars(symbol: string, from: string, to: string): Promise<Bar[]> {
    const url =
      `${this.chart}/${encodeURIComponent(symbol)}` +
      `?interval=1d&period1=${toEpoch(from)}&period2=${toEpoch(to) + 86400}`;

    const body = (await fetchJson(url)) as any;
    const result = body?.chart?.result?.[0];
    if (!result) {
      throw new Error(
        `Yahoo returned no data for ${symbol}: ${body?.chart?.error?.description ?? "unknown"}`,
      );
    }

    const stamps: number[] = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const bars: Bar[] = [];

    for (let i = 0; i < stamps.length; i++) {
      const candidate = {
        symbol,
        date: toISODate(stamps[i]!),
        open: q.open?.[i],
        high: q.high?.[i],
        low: q.low?.[i],
        close: q.close?.[i],
        volume: q.volume?.[i] ?? 0,
      };
      // Halted sessions arrive as nulls; incoherent bars fail the schema.
      // Both are dropped, never patched — a guessed price is worse than a gap.
      const parsed = BarSchema.safeParse(candidate);
      if (parsed.success) bars.push(parsed.data);
    }

    return bars.sort((a, b) => a.date.localeCompare(b.date));
  }

  async news(symbol: string, since: string): Promise<NewsItem[]> {
    const url = `${this.search}?q=${encodeURIComponent(symbol)}&newsCount=10&quotesCount=0`;
    const body = (await fetchJson(url)) as any;
    const cutoff = new Date(`${since}T00:00:00Z`).getTime();

    return ((body?.news ?? []) as any[])
      .map((n): NewsItem => ({
        title: String(n.title ?? ""),
        publisher: String(n.publisher ?? "unknown"),
        publishedAt: new Date((Number(n.providerPublishTime) || 0) * 1000).toISOString(),
        url: String(n.link ?? ""),
      }))
      .filter(
        (n) =>
          n.title && n.url.startsWith("http") && new Date(n.publishedAt).getTime() >= cutoff,
      );
  }
}
