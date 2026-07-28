import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bar, Book, EquitySnapshot, Position, Proposal } from "@quantrade/core";
import { fromBar, fromPosition, toBar, toBook, toPosition, toProposal } from "./mappers.js";

/** Throw on any Supabase error rather than returning a silent empty result —
 *  a swallowed error here becomes a day of missing trades nobody notices. */
function unwrap<T>(
  res: { data: T | null; error: { message: string } | null },
  context: string,
): T {
  if (res.error) throw new Error(`${context}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${context}: no data returned`);
  return res.data;
}

// ---------------------------------------------------------------- books

export async function getBook(sb: SupabaseClient, id: string): Promise<Book> {
  const rows = unwrap(await sb.from("books").select("*").eq("id", id), `getBook(${id})`);
  const row = (rows as any[])[0];
  if (!row) throw new Error(`No book with id "${id}"`);
  return toBook(row);
}

export async function updateBookCash(sb: SupabaseClient, id: string, cash: number): Promise<void> {
  const res = await sb.from("books").update({ cash }).eq("id", id);
  if (res.error) throw new Error(`updateBookCash(${id}): ${res.error.message}`);
}

export async function insertEquitySnapshot(
  sb: SupabaseClient,
  snapshot: EquitySnapshot,
  benchmarkValue: number | null,
): Promise<void> {
  const res = await sb.from("equity_snapshots").upsert(
    {
      book_id: snapshot.bookId,
      date: snapshot.date,
      equity: snapshot.equity,
      cash: snapshot.cash,
      deployed: snapshot.deployed,
      benchmark_value: benchmarkValue,
    },
    { onConflict: "book_id,date" },
  );
  if (res.error) throw new Error(`insertEquitySnapshot: ${res.error.message}`);
}

// ---------------------------------------------------------------- bars

export async function getBars(
  sb: SupabaseClient,
  symbol: string,
  from: string,
  to: string,
): Promise<Bar[]> {
  const rows = unwrap(
    await sb.from("daily_bars").select("*").eq("symbol", symbol)
      .gte("date", from).lte("date", to).order("date", { ascending: true }),
    `getBars(${symbol})`,
  );
  return (rows as any[]).map(toBar);
}

export async function latestBarDate(
  sb: SupabaseClient,
  symbol: string,
): Promise<string | null> {
  const rows = unwrap(
    await sb.from("daily_bars").select("date").eq("symbol", symbol)
      .order("date", { ascending: false }).limit(1),
    `latestBarDate(${symbol})`,
  );
  return (rows as any[])[0]?.date ?? null;
}

export async function upsertBars(sb: SupabaseClient, bars: Bar[]): Promise<void> {
  if (bars.length === 0) return;
  const res = await sb.from("daily_bars").upsert(bars.map(fromBar), { onConflict: "symbol,date" });
  if (res.error) throw new Error(`upsertBars: ${res.error.message}`);
}

export async function upsertInstruments(
  sb: SupabaseClient,
  rows: Array<{ symbol: string; market: string; name: string; sector: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const res = await sb.from("instruments").upsert(rows, { onConflict: "symbol" });
  if (res.error) throw new Error(`upsertInstruments: ${res.error.message}`);
}

// ---------------------------------------------------------------- runs

export async function startRun(
  sb: SupabaseClient,
  bookId: string,
  type: "propose" | "settle" | "reflect",
): Promise<string> {
  const rows = unwrap(
    await sb.from("runs").insert({ book_id: bookId, type, status: "running" }).select("id"),
    "startRun",
  );
  return (rows as any[])[0].id as string;
}

export async function finishRun(
  sb: SupabaseClient,
  runId: string,
  status: "ok" | "failed" | "skipped",
  extra: { model?: string; tokens?: number; error?: string } = {},
): Promise<void> {
  const res = await sb.from("runs").update({
    status,
    ended_at: new Date().toISOString(),
    model: extra.model ?? null,
    tokens: extra.tokens ?? null,
    error: extra.error ?? null,
  }).eq("id", runId);
  if (res.error) throw new Error(`finishRun(${runId}): ${res.error.message}`);
}

// ---------------------------------------------------------------- proposals

export interface ProposalInsert {
  run_id: string;
  book_id: string;
  symbol: string;
  direction: string;
  conviction: number;
  stop_loss: number;
  target: number;
  max_hold_sessions: number;
  thesis: string;
  rules_applied: string[];
  falsifier: string;
  signals_snapshot: unknown;
  status: string;
  engine_reject_reason?: string | null;
  expires_at: string;
}

export async function insertProposals(
  sb: SupabaseClient,
  rows: ProposalInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  const res = await sb.from("proposals").insert(rows);
  if (res.error) throw new Error(`insertProposals: ${res.error.message}`);
}

export async function getPendingProposals(
  sb: SupabaseClient,
  bookId: string,
): Promise<Proposal[]> {
  const rows = unwrap(
    await sb.from("proposals").select("*").eq("book_id", bookId).eq("status", "pending"),
    "getPendingProposals",
  );
  return (rows as any[]).map(toProposal);
}

/** Proposals decided (or expired) but not yet turned into positions. */
export async function getUnsettledProposals(
  sb: SupabaseClient,
  bookId: string,
): Promise<Proposal[]> {
  const rows = unwrap(
    await sb.from("proposals")
      .select("*, positions(id)")
      .eq("book_id", bookId)
      .in("status", ["approved", "rejected", "expired"]),
    "getUnsettledProposals",
  );
  return (rows as any[])
    .filter((r) => !r.positions || r.positions.length === 0)
    .map(toProposal);
}

/** Mark still-pending proposals expired once their decision window has closed. */
export async function expireStaleProposals(
  sb: SupabaseClient,
  bookId: string,
  now: string,
): Promise<number> {
  const rows = unwrap(
    await sb.from("proposals")
      .update({ status: "expired", decided_at: now })
      .eq("book_id", bookId).eq("status", "pending").lt("expires_at", now)
      .select("id"),
    "expireStaleProposals",
  );
  return (rows as any[]).length;
}

// ---------------------------------------------------------------- positions

export async function insertPositions(sb: SupabaseClient, positions: Position[]): Promise<void> {
  if (positions.length === 0) return;
  const res = await sb.from("positions").insert(positions.map(fromPosition));
  if (res.error) throw new Error(`insertPositions: ${res.error.message}`);
}

export async function getOpenPositions(
  sb: SupabaseClient,
  bookId: string,
): Promise<Position[]> {
  const rows = unwrap(
    await sb.from("positions").select("*").eq("book_id", bookId).eq("status", "open"),
    "getOpenPositions",
  );
  return (rows as any[]).map(toPosition);
}

export async function closePositions(sb: SupabaseClient, positions: Position[]): Promise<void> {
  for (const p of positions) {
    const res = await sb.from("positions").update({
      status: "closed",
      exit_price: p.exitPrice,
      exit_date: p.exitDate,
      exit_reason: p.exitReason,
      exit_costs: p.exitCosts,
      gross_pnl: p.grossPnl,
      net_pnl: p.netPnl,
    }).eq("id", p.id);
    if (res.error) throw new Error(`closePositions(${p.id}): ${res.error.message}`);
  }
}

export async function getClosedPositions(
  sb: SupabaseClient,
  bookId: string,
  limit = 10,
): Promise<Position[]> {
  const rows = unwrap(
    await sb.from("positions").select("*")
      .eq("book_id", bookId).eq("status", "closed").eq("is_shadow", false)
      .order("exit_date", { ascending: false }).limit(limit),
    "getClosedPositions",
  );
  return (rows as any[]).map(toPosition);
}

// ---------------------------------------------------------------- post-mortems

export async function insertPostMortem(
  sb: SupabaseClient,
  row: { position_id: string; category: string; expected: string; actual: string; lesson: string },
): Promise<void> {
  const res = await sb.from("post_mortems").upsert(row, { onConflict: "position_id" });
  if (res.error) throw new Error(`insertPostMortem: ${res.error.message}`);
}

// ---------------------------------------------------------------- reflections

export async function lastReflectionAt(
  sb: SupabaseClient,
  bookId: string,
): Promise<string | null> {
  const rows = unwrap(
    await sb.from("reflections").select("created_at").eq("book_id", bookId)
      .order("created_at", { ascending: false }).limit(1),
    "lastReflectionAt",
  );
  return (rows as any[])[0]?.created_at ?? null;
}

export async function countClosedSinceLastReflection(
  sb: SupabaseClient,
  bookId: string,
): Promise<number> {
  const since = await lastReflectionAt(sb, bookId);
  let q = sb.from("positions").select("id", { count: "exact", head: true })
    .eq("book_id", bookId).eq("status", "closed").eq("is_shadow", false);
  if (since) q = q.gt("created_at", since);
  const res = await q;
  if (res.error) throw new Error(`countClosedSinceLastReflection: ${res.error.message}`);
  return res.count ?? 0;
}

/** How many reflections this book has already had, so the next one is n+1. */
export async function countReflections(sb: SupabaseClient, bookId: string): Promise<number> {
  const res = await sb.from("reflections")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId);
  if (res.error) throw new Error(`countReflections: ${res.error.message}`);
  return res.count ?? 0;
}

export async function insertReflection(
  sb: SupabaseClient,
  row: {
    run_id: string; book_id: string; trades_covered: string[];
    commit_sha: string | null; summary: string;
    rules_added: string[]; rules_retired: string[];
  },
): Promise<void> {
  const res = await sb.from("reflections").insert(row);
  if (res.error) throw new Error(`insertReflection: ${res.error.message}`);
}
