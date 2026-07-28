import { describe, it, expect, vi } from "vitest";
import { createDataSource } from "../src/resolve.js";
import type { MarketAdapter, NewsItem } from "../src/adapter.js";
import type { Bar } from "@quantrade/core";

const BAR: Bar = {
  symbol: "AAPL", date: "2026-07-20",
  open: 100, high: 101, low: 99, close: 100.5, volume: 1000,
};

const NEWS: NewsItem = {
  title: "t", publisher: "p", publishedAt: "2026-07-20T00:00:00.000Z", url: "https://x.test",
};

function stub(
  name: string,
  bars: () => Promise<Bar[]>,
  news: () => Promise<NewsItem[]> = async () => [],
): MarketAdapter {
  return { name, dailyBars: vi.fn(bars), news: vi.fn(news) };
}

describe("createDataSource — bars", () => {
  it("uses the first adapter when it succeeds", async () => {
    const a = stub("a", async () => [BAR]);
    const b = stub("b", async () => [BAR]);
    const src = createDataSource([a, b]);

    expect(await src.dailyBars("AAPL", "2026-07-20", "2026-07-20")).toEqual([BAR]);
    expect(b.dailyBars).not.toHaveBeenCalled();
  });

  it("falls through to the second host when the first throws", async () => {
    const a = stub("a", async () => { throw new Error("429"); });
    const b = stub("b", async () => [BAR]);
    const src = createDataSource([a, b]);

    expect(await src.dailyBars("AAPL", "2026-07-20", "2026-07-20")).toEqual([BAR]);
    expect(b.dailyBars).toHaveBeenCalledOnce();
  });

  it("falls through when the first host returns nothing", async () => {
    const a = stub("a", async () => []);
    const b = stub("b", async () => [BAR]);
    const src = createDataSource([a, b]);
    expect(await src.dailyBars("AAPL", "2026-07-20", "2026-07-20")).toEqual([BAR]);
  });

  it("returns empty rather than throwing when every host agrees there is no data", async () => {
    const a = stub("a", async () => []);
    const b = stub("b", async () => []);
    const src = createDataSource([a, b]);
    expect(await src.dailyBars("DELISTED", "2026-07-20", "2026-07-20")).toEqual([]);
  });

  it("surfaces the FIRST error when every host throws", async () => {
    const a = stub("a", async () => { throw new Error("primary boom"); });
    const b = stub("b", async () => { throw new Error("secondary boom"); });
    const src = createDataSource([a, b]);

    await expect(src.dailyBars("AAPL", "2026-07-20", "2026-07-20"))
      .rejects.toThrow(/primary boom/);
  });

  it("prefers real data over an earlier empty result", async () => {
    const a = stub("a", async () => []);
    const b = stub("b", async () => { throw new Error("boom"); });
    const c = stub("c", async () => [BAR]);
    const src = createDataSource([a, b, c]);
    expect(await src.dailyBars("AAPL", "2026-07-20", "2026-07-20")).toEqual([BAR]);
  });
});

describe("createDataSource — news", () => {
  it("treats an empty news list as a valid answer, not a failure", async () => {
    const a = stub("a", async () => [BAR], async () => []);
    const b = stub("b", async () => [BAR], async () => [NEWS]);
    const src = createDataSource([a, b]);

    expect(await src.news("AAPL", "2026-07-01")).toEqual([]);
    expect(b.news).not.toHaveBeenCalled();
  });

  it("falls through when a news fetch throws", async () => {
    const a = stub("a", async () => [BAR], async () => { throw new Error("down"); });
    const b = stub("b", async () => [BAR], async () => [NEWS]);
    const src = createDataSource([a, b]);
    expect(await src.news("AAPL", "2026-07-01")).toEqual([NEWS]);
  });
});

describe("createDataSource — defaults", () => {
  it("defaults to both Yahoo hosts", () => {
    expect(createDataSource().name).toBe("yahoo:query1->yahoo:query2");
  });

  it("refuses an empty adapter chain", () => {
    expect(() => createDataSource([])).toThrow(/at least one adapter/i);
  });
});
