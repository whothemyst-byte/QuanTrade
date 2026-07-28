import { describe, it, expect } from "vitest";
import { settle, type PendingEntry } from "../src/engine.js";
import { sessionsBetween } from "../src/calendar.js";
import type { Bar, Book, EquitySnapshot, Position, Proposal } from "@quantrade/core";
import fixtures from "./fixtures/golden-bars.json";

const BARS = fixtures as unknown as Record<string, Bar[]>;

function barsFor(date: string): Record<string, Bar> {
  const out: Record<string, Bar> = {};
  for (const [symbol, series] of Object.entries(BARS)) {
    const bar = series.find((b) => b.date === date);
    if (bar) out[symbol] = bar;
  }
  return out;
}

function proposal(over: Partial<Proposal>): Proposal {
  return {
    id: "x", bookId: "b-us", symbol: "SOLID", direction: "long",
    conviction: 0.6, stopLoss: 0, target: 0, maxHoldSessions: 5,
    thesis: "golden", rulesApplied: [], whatWouldFalsifyThis: "n/a",
    status: "approved",
    ...over,
  };
}

/** All four positions are opened on the first session, then the book runs
 *  untouched. Nothing is re-proposed, so the only thing under test is the
 *  engine's own exit and marking behaviour. */
const ENTRIES: Record<string, PendingEntry[]> = {
  "2026-07-01": [
    { proposal: proposal({ id: "p-solid",   symbol: "SOLID",   stopLoss: 94,  target: 120, maxHoldSessions: 10 }), sector: "IT" },
    { proposal: proposal({ id: "p-gappy",   symbol: "GAPPY",   stopLoss: 190, target: 240, maxHoldSessions: 10 }), sector: "ENERGY" },
    { proposal: proposal({ id: "p-choppy",  symbol: "CHOPPY",  stopLoss: 45,  target: 60,  maxHoldSessions: 3  }), sector: "FMCG" },
    { proposal: proposal({ id: "p-whipsaw", symbol: "WHIPSAW", stopLoss: 270, target: 335, maxHoldSessions: 10 }), sector: "PHARMA" },
  ],
};

const SECTORS = { SOLID: "IT", GAPPY: "ENERGY", CHOPPY: "FMCG", WHIPSAW: "PHARMA" };

function replay() {
  let book: Book = {
    id: "b-us", market: "US", currency: "USD",
    startingCapital: 999_999, cash: 999_999,
  };
  let open: Position[] = [];
  const closed: Position[] = [];
  const snapshots: EquitySnapshot[] = [];

  for (const date of sessionsBetween("US", "2026-07-01", "2026-07-15")) {
    const r = settle({
      book, date,
      openPositions: open,
      pendingEntries: ENTRIES[date] ?? [],
      bars: barsFor(date),
      sectors: SECTORS,
    });
    book = r.book;
    open = r.stillOpen;
    closed.push(...r.closed);
    snapshots.push(r.snapshot);
  }

  return { book, open, closed, snapshots };
}

describe("golden replay", () => {
  it("produces the expected exit reason for each archetype", () => {
    const { closed } = replay();
    const byId = Object.fromEntries(closed.map((c) => [c.proposalId, c]));

    expect(byId["p-solid"]?.exitReason).toBe("target");
    expect(byId["p-gappy"]?.exitReason).toBe("stop");
    expect(byId["p-choppy"]?.exitReason).toBe("max_hold");
    expect(byId["p-whipsaw"]?.exitReason).toBe("stop");
  });

  it("fills the gapped stop at the open, not at the stop price", () => {
    const { closed } = replay();
    const gappy = closed.find((c) => c.proposalId === "p-gappy")!;
    // Opened at 170, well below the 190 stop.
    expect(gappy.exitPrice!).toBeLessThan(190);
    expect(gappy.exitPrice!).toBeCloseTo(170 * (1 - 0.0015), 2);
  });

  it("gives the stop priority on the whipsaw session", () => {
    const { closed } = replay();
    const whip = closed.find((c) => c.proposalId === "p-whipsaw")!;
    expect(whip.exitReason).toBe("stop");
    expect(whip.exitDate).toBe("2026-07-02");
  });

  it("closes every position and leaves the book flat", () => {
    const { open, closed } = replay();
    expect(closed).toHaveLength(4);
    expect(open).toHaveLength(0);
  });

  it("LOCKS the final equity — see fixtures/README.md before changing this", () => {
    const { snapshots } = replay();
    const final = snapshots.at(-1)!;
    // 999,999 start. SOLID +9,815.33 / GAPPY -7,606.95 / CHOPPY +638.72 /
    // WHIPSAW -5,121.10, less ~5.80 of sell-side SEC and TAF fees.
    expect(final.equity).toBe(997_719.19);
    expect(final.deployed).toBe(0);
  });

  it("never lets net P&L exceed gross P&L", () => {
    const { closed } = replay();
    for (const c of closed) {
      expect(c.netPnl!).toBeLessThanOrEqual(c.grossPnl!);
    }
  });
});
