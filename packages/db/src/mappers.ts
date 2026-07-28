import type { Bar, Book, Position, Proposal } from "@quantrade/core";

/**
 * Supabase returns numeric columns as strings and columns as snake_case.
 * Every mapping bug in this project will originate here, which is why the
 * conversion lives in one place and is tested on its own, away from any I/O.
 */
function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`Expected a numeric value, received ${String(value)}`);
  return n;
}

function required(value: unknown, field: string): number {
  const n = num(value);
  if (n === undefined) throw new Error(`Missing required numeric column "${field}"`);
  return n;
}

export function toBook(row: Record<string, any>): Book {
  return {
    id: row.id,
    market: row.market,
    currency: row.currency,
    startingCapital: required(row.starting_capital, "starting_capital"),
    cash: required(row.cash, "cash"),
  };
}

export function toBar(row: Record<string, any>): Bar {
  return {
    symbol: row.symbol,
    date: row.date,
    open: required(row.open, "open"),
    high: required(row.high, "high"),
    low: required(row.low, "low"),
    close: required(row.close, "close"),
    volume: required(row.volume, "volume"),
  };
}

export function fromBar(bar: Bar): Record<string, unknown> {
  return {
    symbol: bar.symbol, date: bar.date,
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    volume: bar.volume,
  };
}

export function toPosition(row: Record<string, any>): Position {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    bookId: row.book_id,
    symbol: row.symbol,
    sector: row.sector,
    direction: row.direction,
    qty: required(row.qty, "qty"),
    entryPrice: required(row.entry_price, "entry_price"),
    entryDate: row.entry_date,
    stopLoss: required(row.stop_loss, "stop_loss"),
    target: required(row.target, "target"),
    maxHoldSessions: required(row.max_hold_sessions, "max_hold_sessions"),
    entryCosts: required(row.entry_costs, "entry_costs"),
    status: row.status,
    isShadow: Boolean(row.is_shadow),
    ...(num(row.exit_price) !== undefined && { exitPrice: num(row.exit_price) }),
    ...(row.exit_date && { exitDate: row.exit_date }),
    ...(row.exit_reason && { exitReason: row.exit_reason }),
    ...(num(row.exit_costs) !== undefined && { exitCosts: num(row.exit_costs) }),
    ...(num(row.gross_pnl) !== undefined && { grossPnl: num(row.gross_pnl) }),
    ...(num(row.net_pnl) !== undefined && { netPnl: num(row.net_pnl) }),
  } as Position;
}

export function fromPosition(p: Position): Record<string, unknown> {
  return {
    proposal_id: p.proposalId,
    book_id: p.bookId,
    symbol: p.symbol,
    sector: p.sector,
    direction: p.direction,
    qty: p.qty,
    entry_price: p.entryPrice,
    entry_date: p.entryDate,
    stop_loss: p.stopLoss,
    target: p.target,
    max_hold_sessions: p.maxHoldSessions,
    entry_costs: p.entryCosts,
    status: p.status,
    is_shadow: p.isShadow,
    exit_price: p.exitPrice ?? null,
    exit_date: p.exitDate ?? null,
    exit_reason: p.exitReason ?? null,
    exit_costs: p.exitCosts ?? null,
    gross_pnl: p.grossPnl ?? null,
    net_pnl: p.netPnl ?? null,
  };
}

export function toProposal(row: Record<string, any>): Proposal {
  return {
    id: row.id,
    bookId: row.book_id,
    symbol: row.symbol,
    direction: row.direction,
    conviction: required(row.conviction, "conviction"),
    stopLoss: required(row.stop_loss, "stop_loss"),
    target: required(row.target, "target"),
    maxHoldSessions: required(row.max_hold_sessions, "max_hold_sessions"),
    thesis: row.thesis,
    rulesApplied: row.rules_applied ?? [],
    whatWouldFalsifyThis: row.falsifier,
    status: row.status,
    ...(row.engine_reject_reason && { engineRejectReason: row.engine_reject_reason }),
  } as Proposal;
}
