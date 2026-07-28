export interface ClosedTrade {
  qty: number;
  entryPrice: number;
  grossPnl?: number | null;
  netPnl?: number | null;
  entryCosts?: number | null;
  exitCosts?: number | null;
}

export interface Stats {
  tradeCount: number;
  winRate: number | null;
  winRateSuppressed: boolean;
  totalNetPnl: number;
  totalGrossPnl: number;
  totalCosts: number;
  avgWin: number | null;
  avgLoss: number | null;
  maxDrawdownPct: number;
  expectancy: number | null;
}

/** Below this, a win rate is noise dressed as a number. */
export const MIN_TRADES_FOR_WIN_RATE = 20;

export function netPct(t: ClosedTrade): number | null {
  const committed = t.qty * t.entryPrice;
  if (!committed || t.netPnl === null || t.netPnl === undefined) return null;
  return (t.netPnl / committed) * 100;
}

export function computeStats(trades: ClosedTrade[]): Stats {
  const closed = trades.filter((t) => t.netPnl !== null && t.netPnl !== undefined);
  const tradeCount = closed.length;

  // Classification is on NET, never gross. A trade that made money before costs
  // and lost money after is a loss, and the UI must say so.
  const winners = closed.filter((t) => (t.netPnl ?? 0) > 0);
  const losers = closed.filter((t) => (t.netPnl ?? 0) <= 0);

  const totalNetPnl = closed.reduce((s, t) => s + (t.netPnl ?? 0), 0);
  const totalGrossPnl = closed.reduce((s, t) => s + (t.grossPnl ?? 0), 0);
  const totalCosts = closed.reduce(
    (s, t) => s + (t.entryCosts ?? 0) + (t.exitCosts ?? 0),
    0,
  );

  const suppressed = tradeCount < MIN_TRADES_FOR_WIN_RATE;

  // Drawdown over the realised-P&L path, in percent of peak.
  let running = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  for (const t of closed) {
    running += t.netPnl ?? 0;
    peak = Math.max(peak, running);
    if (peak > 0) {
      maxDrawdownPct = Math.min(maxDrawdownPct, ((running - peak) / peak) * 100);
    }
  }

  const avgWin = winners.length
    ? winners.reduce((s, t) => s + (t.netPnl ?? 0), 0) / winners.length
    : null;
  const avgLoss = losers.length
    ? losers.reduce((s, t) => s + (t.netPnl ?? 0), 0) / losers.length
    : null;

  return {
    tradeCount,
    winRate: suppressed ? null : (winners.length / tradeCount) * 100,
    winRateSuppressed: suppressed,
    totalNetPnl: Math.round(totalNetPnl * 100) / 100,
    totalGrossPnl: Math.round(totalGrossPnl * 100) / 100,
    totalCosts: Math.round(totalCosts * 100) / 100,
    avgWin,
    avgLoss,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    expectancy: tradeCount ? totalNetPnl / tradeCount : null,
  };
}

export interface Snapshot {
  date: string;
  equity: number;
  benchmarkValue?: number | null;
}

export interface CurvePoint {
  date: string;
  agent: number;
  benchmark: number | null;
}

/**
 * Normalise the benchmark to the book's starting capital so the two lines are
 * directly comparable. The benchmark is the thing the agent is judged against,
 * so it gets equal visual weight rather than being a faint reference.
 */
export function buildCurve(snapshots: Snapshot[], startingCapital: number): CurvePoint[] {
  const firstWithBenchmark = snapshots.find(
    (s) => s.benchmarkValue !== null && s.benchmarkValue !== undefined,
  );
  const base = firstWithBenchmark?.benchmarkValue ?? null;

  return snapshots.map((s) => ({
    date: s.date,
    agent: s.equity,
    benchmark:
      base && s.benchmarkValue
        ? Math.round((s.benchmarkValue / base) * startingCapital * 100) / 100
        : null,
  }));
}
