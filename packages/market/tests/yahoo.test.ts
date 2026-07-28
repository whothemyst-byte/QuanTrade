import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { YahooAdapter } from "../src/yahoo.js";
import chartFixture from "./fixtures/yahoo-chart-aapl.json";
import searchFixture from "./fixtures/yahoo-search-aapl.json";

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const TIMESTAMP_COUNT = (chartFixture as any).chart.result[0].timestamp.length;

describe("YahooAdapter.dailyBars", () => {
  beforeEach(() => vi.stubGlobal("fetch", mockFetchOnce(chartFixture)));
  afterEach(() => vi.unstubAllGlobals());

  it("maps the chart response into validated bars", async () => {
    const bars = await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-28");
    expect(bars.length).toBeGreaterThan(0);
    const first = bars[0]!;
    expect(first.symbol).toBe("AAPL");
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.high).toBeGreaterThanOrEqual(Math.max(first.open, first.close));
    expect(first.low).toBeLessThanOrEqual(Math.min(first.open, first.close));
  });

  it("returns bars in ascending date order", async () => {
    const bars = await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-28");
    const dates = bars.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("drops sessions where Yahoo returned nulls", async () => {
    const holed = structuredClone(chartFixture) as any;
    holed.chart.result[0].indicators.quote[0].close[1] = null;
    vi.stubGlobal("fetch", mockFetchOnce(holed));

    const bars = await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-28");
    expect(bars).toHaveLength(TIMESTAMP_COUNT - 1);
  });

  it("drops incoherent bars rather than repairing them", async () => {
    const broken = structuredClone(chartFixture) as any;
    broken.chart.result[0].indicators.quote[0].high[0] = 0.01; // below the low
    vi.stubGlobal("fetch", mockFetchOnce(broken));

    const bars = await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-28");
    expect(bars).toHaveLength(TIMESTAMP_COUNT - 1);
  });

  it("throws a descriptive error when Yahoo reports one", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({ chart: { result: null, error: { description: "Not Found" } } }),
    );
    await expect(
      new YahooAdapter().dailyBars("NOPE", "2026-07-20", "2026-07-28"),
    ).rejects.toThrow(/Not Found/);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({}, 404));
    await expect(
      new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-28"),
    ).rejects.toThrow(/404/);
  });

  it("retries once on a 429 and succeeds on the second attempt", async () => {
    let call = 0;
    const spy = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1
        ? { ok: false, status: 429, json: async () => ({}), text: async () => "" }
        : { ok: true, status: 200, json: async () => chartFixture, text: async () => "" };
    });
    vi.stubGlobal("fetch", spy);

    const bars = await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-28");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(bars).toHaveLength(TIMESTAMP_COUNT);
  }, 15_000);

  it("gives up after one retry rather than hammering a rate limit", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({}), text: async () => "",
    });
    vi.stubGlobal("fetch", spy);

    await expect(
      new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-28"),
    ).rejects.toThrow(/429/);
    expect(spy).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("sends a browser User-Agent", async () => {
    const spy = mockFetchOnce(chartFixture);
    vi.stubGlobal("fetch", spy);
    await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-28");
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(/Mozilla/);
  });
});

describe("YahooAdapter.news", () => {
  beforeEach(() => vi.stubGlobal("fetch", mockFetchOnce(searchFixture)));
  afterEach(() => vi.unstubAllGlobals());

  it("maps search results into news items", async () => {
    const items = await new YahooAdapter().news("AAPL", "2026-01-01");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({
      title: expect.any(String),
      publisher: expect.any(String),
      url: expect.stringMatching(/^https?:\/\//),
    });
  });

  it("excludes items older than the cutoff", async () => {
    const items = await new YahooAdapter().news("AAPL", "2099-01-01");
    expect(items).toHaveLength(0);
  });

  it("returns an empty array when the response has no news key", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ quotes: [] }));
    expect(await new YahooAdapter().news("AAPL", "2026-01-01")).toEqual([]);
  });
});
