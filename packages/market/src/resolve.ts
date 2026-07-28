import type { Bar } from "@quantrade/core";
import type { MarketAdapter, NewsItem } from "./adapter.js";
import { YahooAdapter, YAHOO_HOSTS } from "./yahoo.js";

/**
 * Chain adapters so a per-host failure does not cost us the trading day.
 *
 * Originally this fell back to Stooq, but as of 2026-07-28 Stooq serves a
 * JavaScript proof-of-work challenge to non-browser clients on both its .com
 * and .pl domains, which makes it unusable from a scheduled job. Yahoo's two
 * hosts serve identical data, so chaining them covers the realistic failure —
 * one host rate-limiting us — without introducing a second source whose
 * numbers could silently disagree.
 *
 * What this deliberately does NOT cover is a Yahoo-wide outage. In that case
 * every adapter fails, the error propagates, and the run is recorded as failed.
 * The spec is explicit that a missing day beats a day of wrong data.
 */
export function createDataSource(adapters?: MarketAdapter[]): MarketAdapter {
  const chain = adapters ?? YAHOO_HOSTS.map((host) => new YahooAdapter(host));
  if (chain.length === 0) throw new Error("createDataSource requires at least one adapter");

  async function attempt<T>(
    operation: (adapter: MarketAdapter) => Promise<T>,
    isEmpty: (value: T) => boolean,
  ): Promise<T> {
    let firstError: unknown;
    let lastValue: T | undefined;

    for (const adapter of chain) {
      try {
        const value = await operation(adapter);
        if (!isEmpty(value)) return value;
        lastValue = value; // empty is not an error; try the next host, keep this
      } catch (err) {
        // The first failure is the most informative — later hosts often fail
        // for a knock-on reason. Keep it and surface it if nothing succeeds.
        firstError ??= err;
      }
    }

    if (lastValue !== undefined) return lastValue;
    throw firstError ?? new Error("Every data source failed without reporting why");
  }

  return {
    name: chain.map((a) => a.name).join("->"),

    dailyBars(symbol: string, from: string, to: string): Promise<Bar[]> {
      return attempt(
        (a) => a.dailyBars(symbol, from, to),
        (bars) => bars.length === 0,
      );
    },

    news(symbol: string, since: string): Promise<NewsItem[]> {
      return attempt(
        (a) => a.news(symbol, since),
        // No news is a legitimate answer, so never treat [] as a failure worth
        // retrying against another host.
        () => false,
      );
    },
  };
}
