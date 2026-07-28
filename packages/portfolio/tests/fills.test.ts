import { describe, it, expect } from "vitest";
import { applySlippage, resolveEntry, resolveExit, SLIPPAGE_RATE } from "../src/fills.js";
import type { Bar } from "@quantrade/core";

function bar(over: Partial<Bar> = {}): Bar {
  return {
    symbol: "AAA", date: "2026-07-28",
    open: 100, high: 105, low: 95, close: 102, volume: 1000,
    ...over,
  };
}

describe("applySlippage", () => {
  it("always moves the price against us", () => {
    expect(applySlippage(100, "buy")).toBe(100.15);
    expect(applySlippage(100, "sell")).toBe(99.85);
  });

  it("uses the documented 0.15% rate", () => {
    expect(SLIPPAGE_RATE).toBe(0.0015);
  });
});

describe("resolveEntry", () => {
  it("fills a long at the open plus slippage", () => {
    expect(resolveEntry(bar({ open: 200 }), "long")).toBe(200.3);
  });

  it("fills a short at the open minus slippage", () => {
    expect(resolveEntry(bar({ open: 200 }), "short")).toBe(199.7);
  });
});

describe("resolveExit — long positions", () => {
  const pos = { direction: "long" as const, stopLoss: 90, target: 120 };

  it("returns null when neither level is touched", () => {
    expect(resolveExit(bar({ open: 100, high: 110, low: 95, close: 105 }), pos)).toBeNull();
  });

  it("exits at the stop when the low touches it", () => {
    const r = resolveExit(bar({ open: 100, high: 105, low: 89, close: 95 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(90, "sell"));
  });

  it("exits at the target when the high touches it", () => {
    const r = resolveExit(bar({ open: 100, high: 121, low: 99, close: 119 }), pos);
    expect(r?.reason).toBe("target");
    expect(r?.price).toBe(applySlippage(120, "sell"));
  });

  it("gives the stop priority when both are touched in one session", () => {
    const r = resolveExit(bar({ open: 100, high: 125, low: 88, close: 110 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(90, "sell"));
  });

  it("fills at the open, not the stop, when the session gaps below it", () => {
    const r = resolveExit(bar({ open: 80, high: 85, low: 78, close: 82 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(80, "sell")); // 80, not 90
  });

  it("fills at the open when the session gaps above the target", () => {
    const r = resolveExit(bar({ open: 130, high: 135, low: 128, close: 133 }), pos);
    expect(r?.reason).toBe("target");
    expect(r?.price).toBe(applySlippage(130, "sell"));
  });

  it("prefers the stop when the session gaps below it and later reaches the target", () => {
    const r = resolveExit(bar({ open: 80, high: 125, low: 79, close: 120 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(80, "sell"));
  });
});

describe("resolveExit — short positions", () => {
  const pos = { direction: "short" as const, stopLoss: 120, target: 90 };

  it("exits at the stop when the high touches it", () => {
    const r = resolveExit(bar({ open: 110, high: 121, low: 105, close: 118 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(120, "buy"));
  });

  it("exits at the target when the low touches it", () => {
    const r = resolveExit(bar({ open: 110, high: 112, low: 89, close: 92 }), pos);
    expect(r?.reason).toBe("target");
    expect(r?.price).toBe(applySlippage(90, "buy"));
  });

  it("gives the stop priority when both are touched", () => {
    const r = resolveExit(bar({ open: 110, high: 125, low: 85, close: 100 }), pos);
    expect(r?.reason).toBe("stop");
  });

  it("fills at the open when the session gaps above the stop", () => {
    const r = resolveExit(bar({ open: 140, high: 145, low: 138, close: 142 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(140, "buy"));
  });
});
