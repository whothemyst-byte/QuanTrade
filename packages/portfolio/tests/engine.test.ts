import { describe, it, expect } from "vitest";
import { settle } from "../src/engine.js";
import { applySlippage } from "../src/fills.js";
import { computeCosts } from "../src/costs.js";
import type { Bar, Book, Position, Proposal } from "@quantrade/core";

const book: Book = {
  id: "b-us", market: "US", currency: "USD",
  startingCapital: 999_999, cash: 999_999,
};

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "pr-1", bookId: "b-us", symbol: "AAA", direction: "long",
    conviction: 0.7, stopLoss: 90, target: 130, maxHoldSessions: 5,
    thesis: "t", rulesApplied: [], whatWouldFalsifyThis: "f",
    status: "approved",
    ...over,
  };
}

function bar(over: Partial<Bar> = {}): Bar {
  return {
    symbol: "AAA", date: "2026-07-28",
    open: 100, high: 104, low: 98, close: 103, volume: 5000,
    ...over,
  };
}

describe("settle — opening positions", () => {
  it("opens an approved proposal at the session open plus slippage", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [], pendingEntries: [{ proposal: proposal(), sector: "IT" }],
      bars: { AAA: bar() }, sectors: { AAA: "IT" },
    });

    expect(r.opened).toHaveLength(1);
    const p = r.opened[0]!;
    expect(p.entryPrice).toBe(applySlippage(100, "buy"));
    expect(p.entryDate).toBe("2026-07-28");
    expect(p.qty).toBeGreaterThan(0);
    expect(p.status).toBe("open");
  });

  it("debits cash by notional plus entry costs", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [], pendingEntries: [{ proposal: proposal(), sector: "IT" }],
      bars: { AAA: bar() }, sectors: { AAA: "IT" },
    });
    const p = r.opened[0]!;
    const expected = 999_999 - (p.qty * p.entryPrice) - p.entryCosts;
    expect(r.book.cash).toBeCloseTo(expected, 2);
  });

  it("records an engine rejection instead of opening when a limit is breached", () => {
    const r = settle({
      book: { ...book, market: "NSE", id: "b-nse", currency: "INR" },
      date: "2026-07-28",
      openPositions: [],
      pendingEntries: [{ proposal: proposal({ direction: "short", stopLoss: 130, target: 80 }), sector: "IT" }],
      bars: { AAA: bar() }, sectors: { AAA: "IT" },
    });
    expect(r.opened).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/short/i);
  });

  it("rejects a proposal whose bar is missing rather than guessing a price", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [], pendingEntries: [{ proposal: proposal(), sector: "IT" }],
      bars: {}, sectors: { AAA: "IT" },
    });
    expect(r.opened).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/no bar/i);
  });
});

describe("settle — closing positions", () => {
  function held(over: Partial<Position> = {}): Position {
    return {
      id: "pos-1", proposalId: "pr-1", bookId: "b-us",
      symbol: "AAA", sector: "IT", direction: "long",
      qty: 100, entryPrice: 100, entryDate: "2026-07-20",
      stopLoss: 90, target: 130, maxHoldSessions: 5,
      status: "open", isShadow: false, entryCosts: 0,
      ...over,
    };
  }

  it("closes at the stop and computes gross, costs and net separately", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [held()], pendingEntries: [],
      bars: { AAA: bar({ open: 95, high: 96, low: 88, close: 89 }) },
      sectors: { AAA: "IT" },
    });

    const c = r.closed[0]!;
    const exitPrice = applySlippage(90, "sell");
    expect(c.exitReason).toBe("stop");
    expect(c.exitPrice).toBe(exitPrice);
    expect(c.grossPnl).toBeCloseTo((exitPrice - 100) * 100, 2);
    expect(c.exitCosts).toBe(computeCosts("US", "sell", 100, exitPrice).total);
    expect(c.netPnl).toBeCloseTo(c.grossPnl! - c.entryCosts - c.exitCosts!, 2);
    expect(c.status).toBe("closed");
  });

  it("credits cash by exit proceeds less exit costs", () => {
    const r = settle({
      book: { ...book, cash: 500_000 }, date: "2026-07-28",
      openPositions: [held()], pendingEntries: [],
      bars: { AAA: bar({ open: 125, high: 131, low: 124, close: 130 }) },
      sectors: { AAA: "IT" },
    });
    const c = r.closed[0]!;
    const proceeds = c.qty * c.exitPrice! - c.exitCosts!;
    expect(r.book.cash).toBeCloseTo(500_000 + proceeds, 2);
  });

  it("force-closes at the open once max hold sessions elapse", () => {
    // Entered 2026-07-20; 5 sessions later is 2026-07-27, so 07-28 is overdue.
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [held({ entryDate: "2026-07-20", maxHoldSessions: 5 })],
      pendingEntries: [],
      bars: { AAA: bar({ open: 101, high: 104, low: 99, close: 103 }) },
      sectors: { AAA: "IT" },
    });
    expect(r.closed[0]?.exitReason).toBe("max_hold");
    expect(r.closed[0]?.exitPrice).toBe(applySlippage(101, "sell"));
  });

  it("lets the stop win over max hold on the same session", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [held({ entryDate: "2026-07-20", maxHoldSessions: 5 })],
      pendingEntries: [],
      bars: { AAA: bar({ open: 95, high: 96, low: 85, close: 87 }) },
      sectors: { AAA: "IT" },
    });
    expect(r.closed[0]?.exitReason).toBe("stop");
  });

  it("holds a position that touches neither level", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [held({ entryDate: "2026-07-27" })], pendingEntries: [],
      bars: { AAA: bar({ open: 100, high: 105, low: 96, close: 104 }) },
      sectors: { AAA: "IT" },
    });
    expect(r.closed).toHaveLength(0);
    expect(r.stillOpen).toHaveLength(1);
  });
});

describe("settle — equity snapshot", () => {
  it("marks open positions to the close and reports cash and deployed", () => {
    const p: Position = {
      id: "pos-1", proposalId: "pr-1", bookId: "b-us",
      symbol: "AAA", sector: "IT", direction: "long",
      qty: 100, entryPrice: 100, entryDate: "2026-07-27",
      stopLoss: 90, target: 130, maxHoldSessions: 5,
      status: "open", isShadow: false, entryCosts: 0,
    };
    const r = settle({
      book: { ...book, cash: 100_000 }, date: "2026-07-28",
      openPositions: [p], pendingEntries: [],
      bars: { AAA: bar({ open: 100, high: 106, low: 99, close: 105 }) },
      sectors: { AAA: "IT" },
    });
    expect(r.snapshot.deployed).toBe(10_500); // 100 x 105 close
    expect(r.snapshot.cash).toBe(100_000);
    expect(r.snapshot.equity).toBe(110_500);
    expect(r.snapshot.date).toBe("2026-07-28");
  });

  it("values a short position inversely", () => {
    const p: Position = {
      id: "pos-2", proposalId: "pr-2", bookId: "b-us",
      symbol: "AAA", sector: "IT", direction: "short",
      qty: 100, entryPrice: 100, entryDate: "2026-07-27",
      stopLoss: 120, target: 80, maxHoldSessions: 5,
      status: "open", isShadow: false, entryCosts: 0,
    };
    const r = settle({
      book: { ...book, cash: 100_000 }, date: "2026-07-28",
      openPositions: [p], pendingEntries: [],
      bars: { AAA: bar({ open: 100, high: 101, low: 94, close: 95 }) },
      sectors: { AAA: "IT" },
    });
    // Short at 100, marked at 95 -> 500 unrealised gain on top of the 10,000 base.
    expect(r.snapshot.deployed).toBe(10_500);
  });
});
