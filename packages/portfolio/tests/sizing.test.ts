import { describe, it, expect } from "vitest";
import { sizePosition, validateProposal } from "../src/sizing.js";
import type { Position } from "@quantrade/core";

const EQUITY = 1_000_000;

function openPosition(over: Partial<Position> = {}): Position {
  return {
    id: "p1", proposalId: "pr1", bookId: "b1",
    symbol: "AAA", sector: "IT", direction: "long",
    qty: 10, entryPrice: 100, entryDate: "2026-07-01",
    stopLoss: 90, target: 130, maxHoldSessions: 10,
    status: "open", isShadow: false, entryCosts: 0,
    ...over,
  };
}

describe("sizePosition", () => {
  it("derives quantity from the stop distance at 2% risk", () => {
    // Risk budget 20,000; stop distance 50 -> 400 shares.
    // Notional 400 x 1000 = 400,000, which breaches the 5% cap (50,000),
    // so it is capped to 50 shares.
    const r = sizePosition({ equity: EQUITY, entryPrice: 1000, stopLoss: 950, direction: "long" });
    expect(r.qty).toBe(50);
    expect(r.notional).toBe(50_000);
  });

  it("lets the risk budget bind when the stop is wide", () => {
    // Risk budget 20,000; stop distance 500 -> 40 shares.
    // Notional 40 x 1000 = 40,000, under the 50,000 cap, so risk binds.
    const r = sizePosition({ equity: EQUITY, entryPrice: 1000, stopLoss: 500, direction: "long" });
    expect(r.qty).toBe(40);
    expect(r.riskAmount).toBe(20_000);
  });

  it("rounds quantity down, never up", () => {
    // Risk budget 20,000; stop distance 300 -> 66.67 -> 66 shares.
    const r = sizePosition({ equity: EQUITY, entryPrice: 700, stopLoss: 400, direction: "long" });
    expect(r.qty).toBe(66);
  });

  it("sizes shorts off the same absolute stop distance", () => {
    const r = sizePosition({ equity: EQUITY, entryPrice: 1000, stopLoss: 1050, direction: "short" });
    expect(r.qty).toBe(50); // 5% cap binds, same as the mirrored long
  });

  it("returns zero when a tight stop cannot buy a single share", () => {
    const r = sizePosition({ equity: 1000, entryPrice: 5000, stopLoss: 4999, direction: "long" });
    expect(r.qty).toBe(0);
  });

  it("throws when the stop sits on the entry", () => {
    expect(() =>
      sizePosition({ equity: EQUITY, entryPrice: 1000, stopLoss: 1000, direction: "long" }),
    ).toThrow(/stop/i);
  });
});

describe("validateProposal", () => {
  const base = {
    market: "US" as const, symbol: "TGT", direction: "long" as const,
    entryPrice: 100, stopLoss: 90, target: 130,
    sector: "IT", equity: EQUITY, cash: EQUITY, openPositions: [] as Position[],
  };

  it("accepts a compliant proposal", () => {
    expect(validateProposal(base)).toEqual({ ok: true });
  });

  it("rejects an NSE short outright", () => {
    const r = validateProposal({ ...base, market: "NSE", direction: "short", stopLoss: 110, target: 80 });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/short/i) });
  });

  it("rejects a long whose stop sits above the entry", () => {
    const r = validateProposal({ ...base, stopLoss: 110 });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/stop/i) });
  });

  it("rejects a ninth open position", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      openPosition({ id: `p${i}`, symbol: `S${i}`, sector: `SEC${i}` }),
    );
    const r = validateProposal({ ...base, openPositions: eight });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/8 open positions/i) });
  });

  it("rejects a second position in a symbol already held", () => {
    const r = validateProposal({
      ...base,
      openPositions: [openPosition({ symbol: "TGT", sector: "ENERGY" })],
    });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/already holds TGT/i) });
  });

  it("allows a different symbol in a sector that has room", () => {
    const r = validateProposal({
      ...base,
      openPositions: [openPosition({ symbol: "OTHER", sector: "ENERGY" })],
    });
    expect(r).toEqual({ ok: true });
  });

  it("rejects a breach of the 25% sector cap", () => {
    // Existing IT exposure: 2400 x 100 = 240,000 (24%). A new 5% IT position
    // takes it to 29%.
    const heavy = openPosition({ symbol: "OTHER", qty: 2400, entryPrice: 100, sector: "IT" });
    const r = validateProposal({ ...base, openPositions: [heavy] });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/sector/i) });
  });

  it("rejects a breach of the 60% deployed cap", () => {
    const heavy = openPosition({ symbol: "OTHER", qty: 5900, entryPrice: 100, sector: "ENERGY" });
    const r = validateProposal({ ...base, openPositions: [heavy] });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/deployed/i) });
  });

  it("rejects when cash cannot cover the notional", () => {
    const r = validateProposal({ ...base, cash: 100 });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/cash/i) });
  });
});
