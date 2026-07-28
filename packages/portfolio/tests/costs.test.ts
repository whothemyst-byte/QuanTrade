import { describe, it, expect } from "vitest";
import { computeCosts } from "../src/costs.js";

describe("NSE delivery costs", () => {
  // Turnover: 100 shares x 1000 = 100,000 INR
  it("charges STT, stamp duty, exchange, SEBI and GST on a buy", () => {
    const c = computeCosts("NSE", "buy", 100, 1000);
    expect(c.brokerage).toBe(0);
    expect(c.stt).toBe(100);        // 0.1% of 100,000
    expect(c.stampDuty).toBe(15);   // 0.015% of 100,000
    expect(c.exchangeFees).toBe(2.97);   // 0.00297%
    expect(c.regulatoryFees).toBe(0.1);  // 0.0001%
    expect(c.gst).toBe(0.55);       // 18% of (0 + 2.97 + 0.1) = 0.5526 -> 0.55
    expect(c.total).toBe(118.62);
  });

  it("charges STT but no stamp duty on a sell", () => {
    const c = computeCosts("NSE", "sell", 100, 1000);
    expect(c.stt).toBe(100);
    expect(c.stampDuty).toBe(0);
    expect(c.total).toBe(103.62);
  });

  it("keeps a round trip near 0.22% before slippage", () => {
    const buy = computeCosts("NSE", "buy", 100, 1000);
    const sell = computeCosts("NSE", "sell", 100, 1000);
    const roundTripPct = ((buy.total + sell.total) / 100_000) * 100;
    expect(roundTripPct).toBeGreaterThan(0.2);
    expect(roundTripPct).toBeLessThan(0.25);
  });
});

describe("US costs", () => {
  // Turnover: 100 shares x 200 = 20,000 USD
  it("charges nothing on a buy", () => {
    const c = computeCosts("US", "buy", 100, 200);
    expect(c.total).toBe(0);
  });

  it("charges SEC and TAF fees on a sell", () => {
    const c = computeCosts("US", "sell", 100, 200);
    // SEC 0.00278% of 20,000 = 0.556; TAF 100 x 0.000166 = 0.0166; -> 0.5726 -> 0.57
    expect(c.regulatoryFees).toBe(0.57);
    expect(c.total).toBeGreaterThan(0);
    expect(c.total).toBeLessThan(1);
  });

  it("caps the TAF at 8.30 on very large sells", () => {
    const c = computeCosts("US", "sell", 1_000_000, 50);
    // TAF would be 166.00 uncapped; capped at 8.30.
    // SEC = 0.00278% of 50,000,000 = 1390.00
    expect(c.regulatoryFees).toBe(1398.3);
  });
});

describe("input validation", () => {
  it("rejects a non-integer or negative quantity", () => {
    expect(() => computeCosts("NSE", "buy", 10.5, 100)).toThrow(/quantity/i);
    expect(() => computeCosts("NSE", "buy", -1, 100)).toThrow(/quantity/i);
  });

  it("rejects a non-positive price", () => {
    expect(() => computeCosts("NSE", "buy", 10, 0)).toThrow(/price/i);
  });
});
