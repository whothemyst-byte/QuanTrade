# QuanTrade Plan 2 — Data and Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch daily bars and news for both markets from free, keyless sources, and turn raw candles into a compact textual digest of the ~15 most interesting candidates.

**Architecture:** Two new packages. `@quantrade/market` owns all network I/O behind a single `MarketAdapter` interface with a Yahoo primary and a Stooq fallback. `@quantrade/signals` is pure maths over `Bar[]` with no I/O at all. The boundary is strict: the signal layer never fetches, the market layer never computes indicators.

**Tech Stack:** TypeScript 5.x, Vitest, Zod. Node 20+ built-in `fetch`. No API keys, no SDKs.

## Global Constraints

- **Zero cost.** Yahoo Finance and Stooq are keyless and free. If either starts demanding a key, stop and raise it rather than signing up for anything.
- **No test hits the network.** Every adapter test runs against recorded fixtures. A test that fails when the wifi is off is a broken test.
- **Rate discipline.** Requests are serialised with a 250 ms gap. These are unofficial endpoints and hammering them gets the IP blocked, which takes the whole system down.
- **Bars are validated on write** with `BarSchema` from Plan 1. Malformed data is dropped and logged, never silently repaired.
- **Signals are pure.** No `Date.now()`, no `fetch`, no randomness in `packages/signals/src`.
- **The LLM never sees raw candles.** The digest is the only thing that crosses into the agent.
- Depends on: Plan 1 complete. Spec: `docs/specs/2026-07-28-quantrade-design.md`.

---

## File Structure

```
packages/
├─ market/
│  ├─ src/index.ts
│  ├─ src/adapter.ts          # MarketAdapter interface + shared types
│  ├─ src/http.ts             # rate-limited fetch with retry
│  ├─ src/yahoo.ts            # primary bars + news
│  ├─ src/stooq.ts            # EOD bar fallback
│  ├─ src/resolve.ts          # failover chain
│  ├─ src/universe/nifty100.json
│  ├─ src/universe/sp100.json
│  └─ tests/
└─ signals/
   ├─ src/index.ts
   ├─ src/indicators.ts       # RSI, SMA, ATR, returns, volume…
   ├─ src/features.ts         # Bar[] -> SymbolFeatures
   ├─ src/rank.ts             # score and select top N
   ├─ src/digest.ts           # SymbolFeatures -> text for the LLM
   └─ tests/
```

---

### Task 1: Market adapter interface and the Yahoo implementation

**Files:**
- Create: `packages/market/package.json`, `packages/market/tsconfig.json`
- Create: `packages/market/src/adapter.ts`, `packages/market/src/http.ts`, `packages/market/src/yahoo.ts`
- Create: `packages/market/tests/fixtures/yahoo-chart-aapl.json`, `packages/market/tests/fixtures/yahoo-search-aapl.json`
- Test: `packages/market/tests/yahoo.test.ts`

**Interfaces:**
- Consumes: `Bar`, `BarSchema`, `Market` from `@quantrade/core`.
- Produces:
  - `interface MarketAdapter { name: string; dailyBars(symbol, from, to): Promise<Bar[]>; news(symbol, since): Promise<NewsItem[]> }`
  - `interface NewsItem { title: string; publisher: string; publishedAt: string; url: string }`
  - `class YahooAdapter implements MarketAdapter`
  - `fetchJson(url: string, init?: RequestInit): Promise<unknown>` from `http.ts`

- [ ] **Step 1: Create the package**

`packages/market/package.json`:

```json
{
  "name": "@quantrade/market",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "@quantrade/core": "workspace:*",
    "zod": "^3.23.0"
  }
}
```

`packages/market/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "tests"] }
```

Run: `pnpm install`

- [ ] **Step 2: Record the fixtures**

Fetch two real responses once, by hand, and save them trimmed to three or four
data points so the fixture stays readable:

```bash
curl -s -H "User-Agent: Mozilla/5.0" \
  "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d" \
  > packages/market/tests/fixtures/yahoo-chart-aapl.json

curl -s -H "User-Agent: Mozilla/5.0" \
  "https://query1.finance.yahoo.com/v1/finance/search?q=AAPL&newsCount=5&quotesCount=0" \
  > packages/market/tests/fixtures/yahoo-search-aapl.json
```

The chart response nests everything under
`chart.result[0]`, with `timestamp[]` alongside parallel arrays in
`indicators.quote[0].{open,high,low,close,volume}`. Yahoo emits `null` inside
those arrays for halted sessions — that is the single most important thing the
parser must handle, and Step 3 tests it explicitly.

If the live shape differs from what this task assumes, trust the fixture and
adjust the parser. Do not adjust the fixture to match the parser.

- [ ] **Step 3: Write the failing Yahoo test**

`packages/market/tests/yahoo.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { YahooAdapter } from "../src/yahoo.js";
import chartFixture from "./fixtures/yahoo-chart-aapl.json" with { type: "json" };
import searchFixture from "./fixtures/yahoo-search-aapl.json" with { type: "json" };

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("YahooAdapter.dailyBars", () => {
  beforeEach(() => vi.stubGlobal("fetch", mockFetchOnce(chartFixture)));
  afterEach(() => vi.unstubAllGlobals());

  it("maps the chart response into validated bars", async () => {
    const bars = await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-24");
    expect(bars.length).toBeGreaterThan(0);
    const first = bars[0]!;
    expect(first.symbol).toBe("AAPL");
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.high).toBeGreaterThanOrEqual(Math.max(first.open, first.close));
    expect(first.low).toBeLessThanOrEqual(Math.min(first.open, first.close));
  });

  it("returns bars in ascending date order", async () => {
    const bars = await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-24");
    const dates = bars.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("drops sessions where Yahoo returned nulls", async () => {
    const holed = structuredClone(chartFixture) as any;
    holed.chart.result[0].indicators.quote[0].close[1] = null;
    vi.stubGlobal("fetch", mockFetchOnce(holed));

    const bars = await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-24");
    const original = (chartFixture as any).chart.result[0].timestamp.length;
    expect(bars).toHaveLength(original - 1);
  });

  it("drops incoherent bars rather than repairing them", async () => {
    const broken = structuredClone(chartFixture) as any;
    broken.chart.result[0].indicators.quote[0].high[0] = 0.01; // below the low
    vi.stubGlobal("fetch", mockFetchOnce(broken));

    const bars = await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-24");
    const original = (chartFixture as any).chart.result[0].timestamp.length;
    expect(bars).toHaveLength(original - 1);
  });

  it("throws a descriptive error when Yahoo reports one", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ chart: { result: null, error: { description: "Not Found" } } }));
    await expect(new YahooAdapter().dailyBars("NOPE", "2026-07-20", "2026-07-24"))
      .rejects.toThrow(/Not Found/);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({}, 429));
    await expect(new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-24"))
      .rejects.toThrow(/429/);
  });

  it("sends a browser User-Agent", async () => {
    const spy = mockFetchOnce(chartFixture);
    vi.stubGlobal("fetch", spy);
    await new YahooAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-24");
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(/Mozilla/);
  });
});

describe("YahooAdapter.news", () => {
  beforeEach(() => vi.stubGlobal("fetch", mockFetchOnce(searchFixture)));
  afterEach(() => vi.unstubAllGlobals());

  it("maps search results into news items", async () => {
    const items = await new YahooAdapter().news("AAPL", "2026-07-01");
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
    expect(await new YahooAdapter().news("AAPL", "2026-07-01")).toEqual([]);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `pnpm vitest run packages/market/tests/yahoo.test.ts`
Expected: FAIL — cannot resolve `../src/yahoo.js`.

- [ ] **Step 5: Implement `adapter.ts` and `http.ts`**

`packages/market/src/adapter.ts`:

```ts
import type { Bar } from "@quantrade/core";

export interface NewsItem {
  title: string;
  publisher: string;
  publishedAt: string; // ISO 8601
  url: string;
}

export interface MarketAdapter {
  readonly name: string;
  /** Inclusive date range, both YYYY-MM-DD, ascending result order. */
  dailyBars(symbol: string, from: string, to: string): Promise<Bar[]>;
  news(symbol: string, since: string): Promise<NewsItem[]>;
}
```

`packages/market/src/http.ts`:

```ts
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MIN_GAP_MS = 250;
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/** Rate-limited GET with one retry on 429/5xx. These are unofficial endpoints;
 *  being a polite client is what keeps them available to us. */
export async function fetchJson(url: string, attempt = 0): Promise<unknown> {
  await throttle();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });

  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`GET ${url} failed with ${res.status}`);
  }
  return res.json();
}

export async function fetchText(url: string): Promise<string> {
  await throttle();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
  return res.text();
}
```

- [ ] **Step 6: Implement `yahoo.ts`**

`packages/market/src/yahoo.ts`:

```ts
import { BarSchema, type Bar } from "@quantrade/core";
import type { MarketAdapter, NewsItem } from "./adapter.js";
import { fetchJson } from "./http.js";

const CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";

function toEpoch(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}

function toISODate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export class YahooAdapter implements MarketAdapter {
  readonly name = "yahoo";

  async dailyBars(symbol: string, from: string, to: string): Promise<Bar[]> {
    const url =
      `${CHART}/${encodeURIComponent(symbol)}` +
      `?interval=1d&period1=${toEpoch(from)}&period2=${toEpoch(to) + 86400}`;

    const body = (await fetchJson(url)) as any;
    const result = body?.chart?.result?.[0];
    if (!result) {
      throw new Error(`Yahoo returned no data for ${symbol}: ${body?.chart?.error?.description ?? "unknown"}`);
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
    const url = `${SEARCH}?q=${encodeURIComponent(symbol)}&newsCount=10&quotesCount=0`;
    const body = (await fetchJson(url)) as any;
    const cutoff = new Date(`${since}T00:00:00Z`).getTime();

    return ((body?.news ?? []) as any[])
      .map((n): NewsItem => ({
        title: String(n.title ?? ""),
        publisher: String(n.publisher ?? "unknown"),
        publishedAt: new Date((Number(n.providerPublishTime) || 0) * 1000).toISOString(),
        url: String(n.link ?? ""),
      }))
      .filter((n) => n.title && n.url.startsWith("http") && new Date(n.publishedAt).getTime() >= cutoff);
  }
}
```

- [ ] **Step 7: Run the Yahoo tests**

Run: `pnpm vitest run packages/market/tests/yahoo.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/market
git commit -m "feat(market): Yahoo adapter with schema-validated bars and news"
```

---

### Task 2: Stooq fallback and the failover chain

**Files:**
- Create: `packages/market/src/stooq.ts`, `packages/market/src/resolve.ts`, `packages/market/src/index.ts`
- Create: `packages/market/tests/fixtures/stooq-aapl.csv`
- Test: `packages/market/tests/stooq.test.ts`, `packages/market/tests/resolve.test.ts`

**Interfaces:**
- Consumes: `MarketAdapter`, `fetchText`, `BarSchema`.
- Produces: `class StooqAdapter implements MarketAdapter`, `createDataSource(market: Market): MarketAdapter`.

**Honest limitation to encode:** Stooq's coverage of NSE equities is unreliable. It is a genuine fallback for US symbols and a best-effort one for Indian symbols. Rather than pretend otherwise, `createDataSource` fails loudly for NSE when Yahoo is down — the spec requires a failed run over a run on stale or wrong data.

- [ ] **Step 1: Record the fixture**

```bash
curl -s "https://stooq.com/q/d/l/?s=aapl.us&i=d" | head -6 \
  > packages/market/tests/fixtures/stooq-aapl.csv
```

Expected shape — a header row then ascending dates:

```csv
Date,Open,High,Low,Close,Volume
2026-07-20,210.11,212.40,209.55,211.80,48210000
2026-07-21,211.95,214.00,211.20,213.44,51002000
```

- [ ] **Step 2: Write the failing Stooq test**

`packages/market/tests/stooq.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { StooqAdapter } from "../src/stooq.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSV = readFileSync(join(__dirname, "fixtures/stooq-aapl.csv"), "utf8");

function mockText(body: string, ok = true) {
  return vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, text: async () => body });
}

afterEach(() => vi.unstubAllGlobals());

describe("StooqAdapter", () => {
  it("parses CSV into validated bars within the range", async () => {
    vi.stubGlobal("fetch", mockText(CSV));
    const bars = await new StooqAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-21");
    expect(bars).toHaveLength(2);
    expect(bars[0]!.symbol).toBe("AAPL");
    expect(bars[0]!.date).toBe("2026-07-20");
  });

  it("filters out dates outside the requested range", async () => {
    vi.stubGlobal("fetch", mockText(CSV));
    const bars = await new StooqAdapter().dailyBars("AAPL", "2026-07-21", "2026-07-21");
    expect(bars).toHaveLength(1);
  });

  it("maps an NSE symbol to the .in suffix", async () => {
    const spy = mockText("Date,Open,High,Low,Close,Volume\n");
    vi.stubGlobal("fetch", spy);
    await new StooqAdapter().dailyBars("RELIANCE.NS", "2026-07-20", "2026-07-21");
    expect(spy.mock.calls[0]?.[0]).toContain("s=reliance.in");
  });

  it("returns an empty array for a header-only response", async () => {
    vi.stubGlobal("fetch", mockText("Date,Open,High,Low,Close,Volume\n"));
    expect(await new StooqAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-21")).toEqual([]);
  });

  it("skips malformed rows instead of throwing", async () => {
    vi.stubGlobal("fetch", mockText("Date,Open,High,Low,Close,Volume\n2026-07-20,N/A,N/A,N/A,N/A,N/A\n"));
    expect(await new StooqAdapter().dailyBars("AAPL", "2026-07-20", "2026-07-21")).toEqual([]);
  });

  it("reports that it cannot supply news", async () => {
    await expect(new StooqAdapter().news("AAPL", "2026-07-01")).resolves.toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run packages/market/tests/stooq.test.ts`
Expected: FAIL — cannot resolve `../src/stooq.js`.

- [ ] **Step 4: Implement `stooq.ts`**

`packages/market/src/stooq.ts`:

```ts
import { BarSchema, type Bar } from "@quantrade/core";
import type { MarketAdapter, NewsItem } from "./adapter.js";
import { fetchText } from "./http.js";

/** Yahoo uses RELIANCE.NS / AAPL; Stooq uses reliance.in / aapl.us. */
function toStooqSymbol(symbol: string): string {
  if (symbol.endsWith(".NS")) return `${symbol.slice(0, -3).toLowerCase()}.in`;
  return `${symbol.toLowerCase()}.us`;
}

export class StooqAdapter implements MarketAdapter {
  readonly name = "stooq";

  async dailyBars(symbol: string, from: string, to: string): Promise<Bar[]> {
    const url = `https://stooq.com/q/d/l/?s=${toStooqSymbol(symbol)}&i=d`;
    const csv = await fetchText(url);

    const bars: Bar[] = [];
    for (const line of csv.trim().split("\n").slice(1)) {
      const [date, open, high, low, close, volume] = line.split(",");
      if (!date || date < from || date > to) continue;

      const parsed = BarSchema.safeParse({
        symbol, date,
        open: Number(open), high: Number(high),
        low: Number(low), close: Number(close),
        volume: Number(volume) || 0,
      });
      if (parsed.success) bars.push(parsed.data);
    }
    return bars.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Stooq carries no news. Returning [] is honest; throwing would make the
   *  fallback unusable for bars, which is the only thing it is here for. */
  async news(_symbol: string, _since: string): Promise<NewsItem[]> {
    return [];
  }
}
```

- [ ] **Step 5: Write the failing failover test**

`packages/market/tests/resolve.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createDataSource } from "../src/resolve.js";
import type { Bar } from "@quantrade/core";

const BAR: Bar = {
  symbol: "AAPL", date: "2026-07-20",
  open: 100, high: 101, low: 99, close: 100.5, volume: 1000,
};

function stubAdapter(name: string, impl: () => Promise<Bar[]>) {
  return { name, dailyBars: vi.fn(impl), news: vi.fn(async () => []) };
}

describe("createDataSource", () => {
  it("uses the primary when it succeeds", async () => {
    const primary = stubAdapter("primary", async () => [BAR]);
    const fallback = stubAdapter("fallback", async () => [BAR]);
    const src = createDataSource("US", { primary, fallback });

    expect(await src.dailyBars("AAPL", "2026-07-20", "2026-07-20")).toEqual([BAR]);
    expect(fallback.dailyBars).not.toHaveBeenCalled();
  });

  it("falls back for US when the primary throws", async () => {
    const primary = stubAdapter("primary", async () => { throw new Error("429"); });
    const fallback = stubAdapter("fallback", async () => [BAR]);
    const src = createDataSource("US", { primary, fallback });

    expect(await src.dailyBars("AAPL", "2026-07-20", "2026-07-20")).toEqual([BAR]);
    expect(fallback.dailyBars).toHaveBeenCalledOnce();
  });

  it("falls back when the primary returns nothing", async () => {
    const primary = stubAdapter("primary", async () => []);
    const fallback = stubAdapter("fallback", async () => [BAR]);
    const src = createDataSource("US", { primary, fallback });
    expect(await src.dailyBars("AAPL", "2026-07-20", "2026-07-20")).toEqual([BAR]);
  });

  it("refuses to fall back for NSE and rethrows", async () => {
    const primary = stubAdapter("primary", async () => { throw new Error("Yahoo down"); });
    const fallback = stubAdapter("fallback", async () => [BAR]);
    const src = createDataSource("NSE", { primary, fallback });

    await expect(src.dailyBars("RELIANCE.NS", "2026-07-20", "2026-07-20"))
      .rejects.toThrow(/NSE.*fallback|Yahoo down/);
    expect(fallback.dailyBars).not.toHaveBeenCalled();
  });

  it("surfaces the original error when both sources fail", async () => {
    const primary = stubAdapter("primary", async () => { throw new Error("primary boom"); });
    const fallback = stubAdapter("fallback", async () => { throw new Error("fallback boom"); });
    const src = createDataSource("US", { primary, fallback });

    await expect(src.dailyBars("AAPL", "2026-07-20", "2026-07-20"))
      .rejects.toThrow(/primary boom/);
  });
});
```

- [ ] **Step 6: Implement `resolve.ts` and the barrel**

`packages/market/src/resolve.ts`:

```ts
import type { Market } from "@quantrade/core";
import type { MarketAdapter } from "./adapter.js";
import { YahooAdapter } from "./yahoo.js";
import { StooqAdapter } from "./stooq.js";

export interface Sources {
  primary: MarketAdapter;
  fallback: MarketAdapter;
}

/**
 * Yahoo first, Stooq second — but only for US symbols. Stooq's NSE coverage is
 * unreliable, and the spec is explicit that a failed run beats a run on wrong
 * data. So for NSE we surface the failure and let the scheduler alert.
 */
export function createDataSource(market: Market, sources?: Sources): MarketAdapter {
  const { primary, fallback } = sources ?? {
    primary: new YahooAdapter(),
    fallback: new StooqAdapter(),
  };

  return {
    name: `${primary.name}->${fallback.name}`,

    async dailyBars(symbol, from, to) {
      try {
        const bars = await primary.dailyBars(symbol, from, to);
        if (bars.length > 0) return bars;
        if (market === "NSE") return bars;
      } catch (err) {
        if (market === "NSE") {
          throw new Error(
            `NSE has no trustworthy fallback source; refusing to trade on substitute data. Cause: ${(err as Error).message}`,
            { cause: err },
          );
        }
        try {
          return await fallback.dailyBars(symbol, from, to);
        } catch {
          throw err; // the primary failure is the more informative one
        }
      }
      return fallback.dailyBars(symbol, from, to);
    },

    news(symbol, since) {
      return primary.news(symbol, since);
    },
  };
}
```

`packages/market/src/index.ts`:

```ts
export * from "./adapter.js";
export * from "./yahoo.js";
export * from "./stooq.js";
export * from "./resolve.js";
```

- [ ] **Step 7: Run the market package**

Run: `pnpm vitest run packages/market` then `pnpm typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add packages/market
git commit -m "feat(market): Stooq fallback and a market-aware failover chain"
```

---

### Task 3: Indicators

**Files:**
- Create: `packages/signals/package.json`, `packages/signals/tsconfig.json`
- Create: `packages/signals/src/indicators.ts`
- Test: `packages/signals/tests/indicators.test.ts`

**Interfaces:**
- Consumes: `Bar` from `@quantrade/core`.
- Produces: `sma(values, period)`, `rsi(closes, period)`, `atr(bars, period)`, `pctChange(from, to)`, `volumeRatio(bars, period)`, `realisedVol(closes, period)`. Every function returns `number | null`, with `null` meaning "not enough history" — never `NaN`, never a partial-window approximation.

Returning `null` rather than a best-effort value is the important convention. An RSI computed from 4 bars is not a wrong number, it is a meaningless one, and letting it reach the ranking function would quietly promote the least-known stocks.

- [ ] **Step 1: Create the package**

`packages/signals/package.json`:

```json
{
  "name": "@quantrade/signals",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": { "@quantrade/core": "workspace:*" }
}
```

`packages/signals/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "tests"] }
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing indicator test**

`packages/signals/tests/indicators.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sma, rsi, atr, pctChange, volumeRatio, realisedVol } from "../src/indicators.js";
import type { Bar } from "@quantrade/core";

function series(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    symbol: "T",
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: c, high: c + 1, low: c - 1, close: c, volume: 1000,
  }));
}

describe("sma", () => {
  it("averages the trailing window", () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 2)).toBe(4.5);
  });

  it("returns null without enough history", () => {
    expect(sma([1, 2], 5)).toBeNull();
  });
});

describe("rsi", () => {
  it("returns 100 for an unbroken advance", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(closes, 14)).toBe(100);
  });

  it("returns 0 for an unbroken decline", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(closes, 14)).toBe(0);
  });

  it("sits near 50 for an alternating series", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 2));
    const value = rsi(closes, 14)!;
    expect(value).toBeGreaterThan(30);
    expect(value).toBeLessThan(70);
  });

  it("returns null without enough history", () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  it("stays within 0..100 on noisy input", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 10);
    const value = rsi(closes, 14)!;
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(100);
  });
});

describe("atr", () => {
  it("measures average true range including gaps", () => {
    const bars: Bar[] = [
      { symbol: "T", date: "2026-01-01", open: 10, high: 12, low: 9,  close: 11, volume: 1 },
      { symbol: "T", date: "2026-01-02", open: 11, high: 14, low: 10, close: 13, volume: 1 },
      { symbol: "T", date: "2026-01-03", open: 13, high: 15, low: 12, close: 14, volume: 1 },
    ];
    // TRs after the first bar: max(4, |14-11|, |10-11|) = 4 ; max(3, 2, 1) = 3
    expect(atr(bars, 2)).toBe(3.5);
  });

  it("returns null without enough bars", () => {
    expect(atr(series([1, 2]), 14)).toBeNull();
  });
});

describe("pctChange", () => {
  it("computes a signed percentage", () => {
    expect(pctChange(100, 110)).toBe(10);
    expect(pctChange(100, 90)).toBe(-10);
  });

  it("returns null when the base is zero", () => {
    expect(pctChange(0, 10)).toBeNull();
  });
});

describe("volumeRatio", () => {
  it("compares the latest volume against its trailing average", () => {
    const bars = series([1, 2, 3, 4, 5]).map((b, i) => ({ ...b, volume: i === 4 ? 4000 : 1000 }));
    expect(volumeRatio(bars, 4)).toBe(4);
  });

  it("returns null without enough bars", () => {
    expect(volumeRatio(series([1, 2]), 20)).toBeNull();
  });
});

describe("realisedVol", () => {
  it("returns zero for a flat series", () => {
    expect(realisedVol(Array(30).fill(100), 20)).toBe(0);
  });

  it("grows with dispersion", () => {
    const calm = Array.from({ length: 30 }, (_, i) => 100 + (i % 2) * 0.1);
    const wild = Array.from({ length: 30 }, (_, i) => 100 + (i % 2) * 10);
    expect(realisedVol(wild, 20)!).toBeGreaterThan(realisedVol(calm, 20)!);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run packages/signals/tests/indicators.test.ts`
Expected: FAIL — cannot resolve `../src/indicators.js`.

- [ ] **Step 4: Implement `indicators.ts`**

`packages/signals/src/indicators.ts`:

```ts
import type { Bar } from "@quantrade/core";

/** Every indicator returns null rather than a partial-window approximation.
 *  A half-computed RSI is not a small error, it is a meaningless number that
 *  would still rank against fully-computed ones. */

function round(value: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const window = values.slice(-period);
  return round(window.reduce((a, b) => a + b, 0) / period);
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }

  if (losses === 0) return gains === 0 ? 50 : 100;
  if (gains === 0) return 0;

  const rs = gains / losses;
  return round(100 - 100 / (1 + rs), 2);
}

export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const bar = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    trueRanges.push(
      Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose)),
    );
  }
  return round(trueRanges.reduce((a, b) => a + b, 0) / period);
}

export function pctChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return round(((to - from) / from) * 100, 2);
}

export function volumeRatio(bars: Bar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const latest = bars.at(-1)!.volume;
  const prior = bars.slice(-(period + 1), -1);
  const avg = prior.reduce((a, b) => a + b.volume, 0) / prior.length;
  if (avg === 0) return null;
  return round(latest / avg, 2);
}

/** Annualised standard deviation of daily log returns, as a percentage. */
export function realisedVol(closes: number[], period = 20): number | null {
  if (closes.length < period + 1) return null;

  const returns: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev <= 0) return null;
    returns.push(Math.log(closes[i]! / prev));
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return round(Math.sqrt(variance) * Math.sqrt(252) * 100, 2);
}
```

- [ ] **Step 5: Run the indicator tests**

Run: `pnpm vitest run packages/signals/tests/indicators.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/signals
git commit -m "feat(signals): indicator primitives with explicit insufficient-history nulls"
```

---

### Task 4: Features, ranking, and the LLM digest

**Files:**
- Create: `packages/signals/src/features.ts`, `packages/signals/src/rank.ts`, `packages/signals/src/digest.ts`, `packages/signals/src/index.ts`
- Create: `packages/market/src/universe/nifty100.json`, `packages/market/src/universe/sp100.json`
- Test: `packages/signals/tests/features.test.ts`, `packages/signals/tests/rank.test.ts`, `packages/signals/tests/digest.test.ts`

**Interfaces:**
- Consumes: everything from Task 3, `Bar` from `@quantrade/core`.
- Produces:
  - `interface SymbolFeatures { symbol: string; sector: string; close: number; rsi14: number | null; sma20: number | null; sma50: number | null; sma200: number | null; trend: "above200" | "below200" | "unknown"; atr14: number | null; atrPct: number | null; volRatio20: number | null; ret5: number | null; ret20: number | null; pctFrom52wHigh: number | null; pctFrom52wLow: number | null; gapPct: number | null; realisedVol20: number | null }`
  - `computeFeatures(bars: Bar[], sector: string): SymbolFeatures | null`
  - `rankCandidates(features: SymbolFeatures[], limit: number): SymbolFeatures[]`
  - `buildDigest(features: SymbolFeatures[]): string`

- [ ] **Step 1: Add the universe lists**

`packages/market/src/universe/sp100.json` and
`packages/market/src/universe/nifty100.json`. Each is an array of
`{ symbol, name, sector }`. Yahoo symbol conventions apply: plain tickers for
US, `.NS` suffix for NSE.

```json
[
  { "symbol": "AAPL", "name": "Apple Inc.", "sector": "Technology" },
  { "symbol": "MSFT", "name": "Microsoft Corp.", "sector": "Technology" },
  { "symbol": "JPM",  "name": "JPMorgan Chase", "sector": "Financials" }
]
```

```json
[
  { "symbol": "RELIANCE.NS", "name": "Reliance Industries", "sector": "Energy" },
  { "symbol": "TCS.NS",      "name": "Tata Consultancy",    "sector": "Technology" },
  { "symbol": "HDFCBANK.NS", "name": "HDFC Bank",           "sector": "Financials" }
]
```

Populate each to roughly 100 entries from the current index constituents.
Sector strings must be drawn from one shared vocabulary across both files —
the 25% sector cap in Plan 1 compares these strings directly, so "Tech" in one
file and "Technology" in the other would silently defeat the limit.

Add `packages/market/tests/universe.test.ts` asserting: every symbol is unique,
every NSE symbol ends in `.NS`, no US symbol contains a dot, and the set of
sector strings in both files is drawn from the same allowed list.

- [ ] **Step 2: Write the failing features test**

`packages/signals/tests/features.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeFeatures } from "../src/features.js";
import type { Bar } from "@quantrade/core";

/** Deterministic upward drift with a fixed 1% daily range. */
function trendingBars(n: number, start = 100, step = 0.5): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i * step;
    return {
      symbol: "T",
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      open: close - step / 2, high: close + 1, low: close - 1,
      close, volume: 1000 + i,
    };
  });
}

describe("computeFeatures", () => {
  it("returns null when there is too little history to be meaningful", () => {
    expect(computeFeatures(trendingBars(10), "Technology")).toBeNull();
  });

  it("computes a full feature set from sufficient history", () => {
    const f = computeFeatures(trendingBars(260), "Technology")!;
    expect(f.symbol).toBe("T");
    expect(f.sector).toBe("Technology");
    expect(f.rsi14).toBe(100);          // unbroken advance
    expect(f.trend).toBe("above200");
    expect(f.sma20).toBeGreaterThan(f.sma50!);
    expect(f.pctFrom52wHigh).toBeCloseTo(0, 1);
    expect(f.ret5).toBeGreaterThan(0);
  });

  it("marks a downtrend as below its 200-day", () => {
    const f = computeFeatures(trendingBars(260, 300, -0.5), "Energy")!;
    expect(f.trend).toBe("below200");
    expect(f.rsi14).toBe(0);
  });

  it("reports unknown trend when 200 bars are unavailable", () => {
    const f = computeFeatures(trendingBars(120), "Energy")!;
    expect(f.sma200).toBeNull();
    expect(f.trend).toBe("unknown");
  });

  it("computes the gap from the previous close to today's open", () => {
    const bars = trendingBars(260);
    bars[bars.length - 1]!.open = bars[bars.length - 2]!.close * 1.05;
    const f = computeFeatures(bars, "Energy")!;
    expect(f.gapPct).toBeCloseTo(5, 1);
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then implement `features.ts`**

Run: `pnpm vitest run packages/signals/tests/features.test.ts`
Expected: FAIL — cannot resolve `../src/features.js`.

`packages/signals/src/features.ts`:

```ts
import type { Bar } from "@quantrade/core";
import { atr, pctChange, realisedVol, rsi, sma, volumeRatio } from "./indicators.js";

export interface SymbolFeatures {
  symbol: string;
  sector: string;
  close: number;
  rsi14: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  trend: "above200" | "below200" | "unknown";
  atr14: number | null;
  atrPct: number | null;
  volRatio20: number | null;
  ret5: number | null;
  ret20: number | null;
  pctFrom52wHigh: number | null;
  pctFrom52wLow: number | null;
  gapPct: number | null;
  realisedVol20: number | null;
}

/** Below this, too many features are null for the symbol to be rankable. */
const MIN_BARS = 60;

export function computeFeatures(bars: Bar[], sector: string): SymbolFeatures | null {
  if (bars.length < MIN_BARS) return null;

  const latest = bars.at(-1)!;
  const prev = bars.at(-2)!;
  const closes = bars.map((b) => b.close);

  const sma200 = sma(closes, 200);
  const atr14 = atr(bars, 14);

  const yearBars = bars.slice(-252);
  const high52 = Math.max(...yearBars.map((b) => b.high));
  const low52 = Math.min(...yearBars.map((b) => b.low));

  return {
    symbol: latest.symbol,
    sector,
    close: latest.close,
    rsi14: rsi(closes, 14),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200,
    trend: sma200 === null ? "unknown" : latest.close >= sma200 ? "above200" : "below200",
    atr14,
    atrPct: atr14 === null ? null : pctChange(latest.close, latest.close + atr14),
    volRatio20: volumeRatio(bars, 20),
    ret5: closes.length > 5 ? pctChange(closes.at(-6)!, latest.close) : null,
    ret20: closes.length > 20 ? pctChange(closes.at(-21)!, latest.close) : null,
    pctFrom52wHigh: pctChange(high52, latest.close),
    pctFrom52wLow: pctChange(low52, latest.close),
    gapPct: pctChange(prev.close, latest.open),
    realisedVol20: realisedVol(closes, 20),
  };
}
```

Run again — expected PASS, 5 tests.

- [ ] **Step 4: Write the failing ranking test**

`packages/signals/tests/rank.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rankCandidates } from "../src/rank.js";
import type { SymbolFeatures } from "../src/features.js";

function features(over: Partial<SymbolFeatures>): SymbolFeatures {
  return {
    symbol: "X", sector: "Technology", close: 100,
    rsi14: 50, sma20: 100, sma50: 100, sma200: 100, trend: "above200",
    atr14: 2, atrPct: 2, volRatio20: 1,
    ret5: 0, ret20: 0, pctFrom52wHigh: -10, pctFrom52wLow: 20,
    gapPct: 0, realisedVol20: 20,
    ...over,
  };
}

describe("rankCandidates", () => {
  it("returns at most the requested limit", () => {
    const all = Array.from({ length: 50 }, (_, i) => features({ symbol: `S${i}` }));
    expect(rankCandidates(all, 15)).toHaveLength(15);
  });

  it("ranks an unusual-volume, stretched-RSI name above a dormant one", () => {
    const interesting = features({ symbol: "HOT", rsi14: 22, volRatio20: 3.5, ret5: -9 });
    const dull = features({ symbol: "DULL", rsi14: 50, volRatio20: 1, ret5: 0 });
    const [top] = rankCandidates([dull, interesting], 2);
    expect(top!.symbol).toBe("HOT");
  });

  it("drops symbols with too many nulls to score", () => {
    const incomplete = features({ symbol: "THIN", rsi14: null, volRatio20: null, ret5: null });
    const complete = features({ symbol: "FULL" });
    const ranked = rankCandidates([incomplete, complete], 10);
    expect(ranked.map((f) => f.symbol)).toEqual(["FULL"]);
  });

  it("is deterministic and stable for equal scores", () => {
    const a = features({ symbol: "AAA" });
    const b = features({ symbol: "BBB" });
    expect(rankCandidates([a, b], 2).map((f) => f.symbol))
      .toEqual(rankCandidates([a, b], 2).map((f) => f.symbol));
  });

  it("returns an empty array for an empty universe", () => {
    expect(rankCandidates([], 15)).toEqual([]);
  });
});
```

- [ ] **Step 5: Implement `rank.ts`**

`packages/signals/src/rank.ts`:

```ts
import type { SymbolFeatures } from "./features.js";

/**
 * Score how *interesting* a symbol is — not how bullish. The job here is to
 * hand the LLM the names where something is actually happening, and let it
 * decide direction. A momentum-biased score would quietly make the agent a
 * trend follower before it ever read a headline.
 */
function score(f: SymbolFeatures): number | null {
  if (f.rsi14 === null || f.volRatio20 === null || f.ret5 === null) return null;

  const rsiStretch = Math.abs(f.rsi14 - 50) / 50;        // 0..1
  const volumeUnusual = Math.min(Math.abs(f.volRatio20 - 1), 3) / 3;
  const shortMove = Math.min(Math.abs(f.ret5), 15) / 15;
  const nearExtreme =
    f.pctFrom52wHigh === null || f.pctFrom52wLow === null
      ? 0
      : Math.max(0, 1 - Math.min(Math.abs(f.pctFrom52wHigh), Math.abs(f.pctFrom52wLow)) / 20);
  const gapping = f.gapPct === null ? 0 : Math.min(Math.abs(f.gapPct), 5) / 5;

  return (
    rsiStretch * 0.3 +
    volumeUnusual * 0.25 +
    shortMove * 0.2 +
    nearExtreme * 0.15 +
    gapping * 0.1
  );
}

export function rankCandidates(features: SymbolFeatures[], limit: number): SymbolFeatures[] {
  return features
    .map((f) => ({ f, s: score(f) }))
    .filter((x): x is { f: SymbolFeatures; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.f.symbol.localeCompare(b.f.symbol))
    .slice(0, limit)
    .map((x) => x.f);
}
```

The symbol tie-break is what makes the ranking deterministic — without it,
`Array.prototype.sort` stability varies by input size and the digest would
differ between runs on identical data.

Run: `pnpm vitest run packages/signals/tests/rank.test.ts` — expected PASS, 5 tests.

- [ ] **Step 6: Write the failing digest test**

`packages/signals/tests/digest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildDigest } from "../src/digest.js";
import type { SymbolFeatures } from "../src/features.js";

const sample: SymbolFeatures = {
  symbol: "RELIANCE.NS", sector: "Energy", close: 2950,
  rsi14: 28.4, sma20: 3010, sma50: 3080, sma200: 2890, trend: "above200",
  atr14: 62.5, atrPct: 2.12, volRatio20: 2.3,
  ret5: -6.2, ret20: -3.1, pctFrom52wHigh: -12.4, pctFrom52wLow: 8.9,
  gapPct: -1.8, realisedVol20: 24.6,
};

describe("buildDigest", () => {
  it("renders a symbol as compact readable lines", () => {
    const text = buildDigest([sample]);
    expect(text).toContain("RELIANCE.NS");
    expect(text).toContain("Energy");
    expect(text).toContain("RSI 28.4");
    expect(text).toContain("above its 200-day");
    expect(text).toContain("2.3x");
  });

  it("contains no raw OHLCV arrays", () => {
    const text = buildDigest([sample]);
    expect(text).not.toMatch(/\[\s*\d+(\.\d+)?\s*,/);
  });

  it("says so explicitly when a value is unavailable", () => {
    const text = buildDigest([{ ...sample, rsi14: null, sma200: null, trend: "unknown" }]);
    expect(text).toMatch(/n\/a/i);
    expect(text).not.toContain("null");
    expect(text).not.toContain("NaN");
  });

  it("stays compact enough for a free-tier context window", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ ...sample, symbol: `S${i}.NS` }));
    expect(buildDigest(many).length).toBeLessThan(6000);
  });

  it("handles an empty candidate list", () => {
    expect(buildDigest([])).toMatch(/no candidates/i);
  });
});
```

- [ ] **Step 7: Implement `digest.ts` and the barrel**

`packages/signals/src/digest.ts`:

```ts
import type { SymbolFeatures } from "./features.js";

function n(value: number | null, suffix = "", dp = 1): string {
  return value === null ? "n/a" : `${value.toFixed(dp)}${suffix}`;
}

function trendPhrase(f: SymbolFeatures): string {
  if (f.trend === "unknown") return "200-day trend n/a";
  return f.trend === "above200" ? "above its 200-day" : "below its 200-day";
}

/**
 * Render features as prose the model can reason about. The LLM never receives
 * raw candles — partly for context economy, but mainly because a model asked
 * to eyeball 250 numbers will invent patterns in them.
 */
export function buildDigest(features: SymbolFeatures[]): string {
  if (features.length === 0) {
    return "No candidates cleared the screen today.";
  }

  return features
    .map((f) => {
      return [
        `${f.symbol} (${f.sector}) — last ${n(f.close, "", 2)}`,
        `  RSI ${n(f.rsi14)}, ${trendPhrase(f)}, volume ${n(f.volRatio20, "x", 1)} its 20-day average`,
        `  5-day ${n(f.ret5, "%")}, 20-day ${n(f.ret20, "%")}, gap ${n(f.gapPct, "%")}`,
        `  ${n(f.pctFrom52wHigh, "%")} from the 52-week high, ${n(f.pctFrom52wLow, "%")} from the low`,
        `  ATR ${n(f.atrPct, "% of price", 2)}, realised vol ${n(f.realisedVol20, "%")}`,
      ].join("\n");
    })
    .join("\n\n");
}
```

`packages/signals/src/index.ts`:

```ts
export * from "./indicators.js";
export * from "./features.js";
export * from "./rank.js";
export * from "./digest.js";
```

- [ ] **Step 8: Run everything**

Run: `pnpm test` then `pnpm typecheck`
Expected: all four packages green, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add packages/signals packages/market/src/universe packages/market/tests/universe.test.ts
git commit -m "feat(signals): feature extraction, interest ranking, and the LLM digest"
```

---

## Definition of Done

- [ ] `pnpm test` green across `core`, `portfolio`, `market`, `signals`.
- [ ] Every test passes with networking disabled. Verify by running the suite with the wifi off — any failure means a test is hitting the live internet.
- [ ] `grep -rn "fetch(\|Date.now()" packages/signals/src` returns no matches.
- [ ] Both universe files hold ~100 entries and share one sector vocabulary, enforced by `universe.test.ts`.
- [ ] `buildDigest` output for 15 symbols is under 6,000 characters.
- [ ] Four commits exist, one per task.

## What this plan deliberately does not build

Persistence, the LLM call, scheduling, and the UI — Plans 3 and 4. Note in particular that nothing here writes to Supabase; caching bars into `daily_bars` is Plan 3's job, because that is where the database client is introduced.
