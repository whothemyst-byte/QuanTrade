import { describe, it, expect } from "vitest";
import { computeStats, buildCurve, netPct, MIN_TRADES_FOR_WIN_RATE, type ClosedTrade } from "../lib/stats";

function trades(n: number, winners: number): ClosedTrade[] {
  return Array.from({ length: n }, (_, i) => ({
    qty: 10,
    entryPrice: 100,
    grossPnl: i < winners ? 110 : -40,
    netPnl: i < winners ? 100 : -50,
    entryCosts: 5,
    exitCosts: 5,
  }));
}

describe("computeStats", () => {
  it("suppresses win rate below 20 closed trades", () => {
    const s = computeStats(trades(19, 12));
    expect(s.winRate).toBeNull();
    expect(s.winRateSuppressed).toBe(true);
    expect(s.tradeCount).toBe(19);
  });

  it("reports win rate at exactly the threshold", () => {
    const s = computeStats(trades(MIN_TRADES_FOR_WIN_RATE, 12));
    expect(s.winRate).toBe(60);
    expect(s.winRateSuppressed).toBe(false);
  });

  it("always reports trade count, even at zero", () => {
    const s = computeStats([]);
    expect(s.tradeCount).toBe(0);
    expect(s.winRate).toBeNull();
  });

  it("classifies on net, so a gross winner that lost to costs is a loss", () => {
    const s = computeStats([
      { qty: 10, entryPrice: 100, grossPnl: 50, netPnl: -5, entryCosts: 30, exitCosts: 25 },
      ...trades(19, 19),
    ]);
    expect(s.winRate).toBe(95);
  });

  it("reports total costs paid as a first-class figure", () => {
    const s = computeStats(trades(20, 10));
    expect(s.totalCosts).toBe(200); // 20 trades x (5 + 5)
  });

  it("keeps gross and net distinct", () => {
    const s = computeStats(trades(20, 10));
    expect(s.totalGrossPnl).not.toBe(s.totalNetPnl);
  });

  it("computes a non-positive max drawdown", () => {
    const s = computeStats(trades(20, 10));
    expect(s.maxDrawdownPct).toBeLessThanOrEqual(0);
  });

  it("ignores positions that are not yet closed", () => {
    const s = computeStats([...trades(5, 5), { qty: 10, entryPrice: 100 }]);
    expect(s.tradeCount).toBe(5);
  });
});

describe("netPct", () => {
  it("expresses net P&L against the capital actually committed", () => {
    expect(netPct({ qty: 50, entryPrice: 100, netPnl: 250 })).toBe(5);
  });

  it("returns null for an open position", () => {
    expect(netPct({ qty: 50, entryPrice: 100 })).toBeNull();
  });
});

describe("buildCurve", () => {
  it("normalises the benchmark to the starting capital", () => {
    const curve = buildCurve(
      [
        { date: "2026-07-01", equity: 999999, benchmarkValue: 500 },
        { date: "2026-07-02", equity: 1010000, benchmarkValue: 510 },
      ],
      999999,
    );
    expect(curve[0]!.benchmark).toBe(999999);
    expect(curve[1]!.benchmark).toBeCloseTo(999999 * 1.02, 0);
  });

  it("leaves the benchmark null on days the index quote was missing", () => {
    const curve = buildCurve(
      [
        { date: "2026-07-01", equity: 999999, benchmarkValue: 500 },
        { date: "2026-07-02", equity: 1010000, benchmarkValue: null },
      ],
      999999,
    );
    expect(curve[1]!.benchmark).toBeNull();
    expect(curve[1]!.agent).toBe(1010000);
  });

  it("returns all-null benchmarks when no snapshot ever had one", () => {
    const curve = buildCurve([{ date: "2026-07-01", equity: 999999 }], 999999);
    expect(curve[0]!.benchmark).toBeNull();
  });
});
