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
