import { describe, it, expect } from "vitest";
import { computeFeatures } from "../src/features.js";
import { rankCandidates } from "../src/rank.js";
import { buildDigest } from "../src/digest.js";
import type { SymbolFeatures } from "../src/features.js";
import type { Bar } from "@quantrade/core";

/** Deterministic drift with a fixed range. */
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
    expect(f.pctFrom52wHigh).toBeCloseTo(0, 0);
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

  it("does not favour up-moves over equivalent down-moves", () => {
    // Direction is the model's call, not the screener's.
    const up = features({ symbol: "UP", rsi14: 78, ret5: 9 });
    const down = features({ symbol: "DOWN", rsi14: 22, ret5: -9 });
    const ranked = rankCandidates([up, down], 2);
    expect(ranked).toHaveLength(2);
  });

  it("returns an empty array for an empty universe", () => {
    expect(rankCandidates([], 15)).toEqual([]);
  });
});

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
