import { createServerSupabase } from "./supabase/server";

export const BOOKS = [
  { id: "nse-main", market: "NSE" as const, currency: "INR" as const, label: "NSE" },
  { id: "us-main", market: "US" as const, currency: "USD" as const, label: "US" },
];

export type BookId = (typeof BOOKS)[number]["id"];

export function bookMeta(id: string) {
  return BOOKS.find((b) => b.id === id) ?? BOOKS[1]!;
}

function n(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function maybe(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export async function getBooks() {
  const sb = await createServerSupabase();
  const { data } = await sb.from("books").select("*");
  return (data ?? []).map((b: any) => ({
    id: b.id as string,
    market: b.market as "NSE" | "US",
    currency: b.currency as "INR" | "USD",
    startingCapital: n(b.starting_capital),
    cash: n(b.cash),
  }));
}

export async function getPendingProposals(bookId: string) {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("proposals")
    .select("*")
    .eq("book_id", bookId)
    .eq("status", "pending")
    .order("conviction", { ascending: false });

  return (data ?? []).map((p: any) => ({
    id: p.id as string,
    symbol: p.symbol as string,
    direction: p.direction as "long" | "short",
    conviction: n(p.conviction),
    stopLoss: n(p.stop_loss),
    target: n(p.target),
    maxHoldSessions: n(p.max_hold_sessions),
    thesis: p.thesis as string,
    falsifier: p.falsifier as string,
    rulesApplied: (p.rules_applied ?? []) as string[],
    signals: p.signals_snapshot as Record<string, unknown>,
    expiresAt: p.expires_at as string,
  }));
}

/** The agent's most recent view, shown when the inbox is empty. */
export async function getLatestMarketView(bookId: string) {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("runs")
    .select("started_at, status, error")
    .eq("book_id", bookId)
    .eq("type", "propose")
    .order("started_at", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0] as any;
  return row
    ? { at: row.started_at as string, status: row.status as string, error: row.error as string | null }
    : null;
}

export async function getOpenPositions(bookId: string) {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("positions")
    .select("*")
    .eq("book_id", bookId)
    .eq("status", "open")
    .eq("is_shadow", false)
    .order("entry_date", { ascending: true });

  return (data ?? []).map((p: any) => ({
    id: p.id as string,
    symbol: p.symbol as string,
    sector: p.sector as string,
    direction: p.direction as "long" | "short",
    qty: n(p.qty),
    entryPrice: n(p.entry_price),
    entryDate: p.entry_date as string,
    stopLoss: n(p.stop_loss),
    target: n(p.target),
    maxHoldSessions: n(p.max_hold_sessions),
  }));
}

export async function getLatestCloses(symbols: string[]) {
  if (symbols.length === 0) return {} as Record<string, { close: number; date: string }>;
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("daily_bars")
    .select("symbol, date, close")
    .in("symbol", symbols)
    .order("date", { ascending: false });

  const out: Record<string, { close: number; date: string }> = {};
  for (const row of (data ?? []) as any[]) {
    if (!out[row.symbol]) out[row.symbol] = { close: n(row.close), date: row.date };
  }
  return out;
}

export async function getClosedTrades(bookId: string, includeShadow = false) {
  const sb = await createServerSupabase();
  let q = sb
    .from("positions")
    .select("*, proposals(thesis, falsifier), post_mortems(category, expected, actual, lesson)")
    .eq("book_id", bookId)
    .eq("status", "closed")
    .order("exit_date", { ascending: false });
  if (!includeShadow) q = q.eq("is_shadow", false);

  const { data } = await q;
  return (data ?? []).map((p: any) => {
    const proposal = Array.isArray(p.proposals) ? p.proposals[0] : p.proposals;
    const pm = Array.isArray(p.post_mortems) ? p.post_mortems[0] : p.post_mortems;
    return {
      id: p.id as string,
      symbol: p.symbol as string,
      direction: p.direction as "long" | "short",
      qty: n(p.qty),
      entryPrice: n(p.entry_price),
      entryDate: p.entry_date as string,
      exitPrice: maybe(p.exit_price),
      exitDate: p.exit_date as string | null,
      exitReason: p.exit_reason as string | null,
      grossPnl: maybe(p.gross_pnl),
      netPnl: maybe(p.net_pnl),
      entryCosts: n(p.entry_costs),
      exitCosts: n(p.exit_costs),
      isShadow: Boolean(p.is_shadow),
      thesis: (proposal?.thesis ?? null) as string | null,
      falsifier: (proposal?.falsifier ?? null) as string | null,
      postMortem: pm
        ? {
            category: pm.category as string,
            expected: pm.expected as string,
            actual: pm.actual as string,
            lesson: pm.lesson as string,
          }
        : null,
    };
  });
}

export async function getSnapshots(bookId: string) {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("equity_snapshots")
    .select("*")
    .eq("book_id", bookId)
    .order("date", { ascending: true });

  return (data ?? []).map((s: any) => ({
    date: s.date as string,
    equity: n(s.equity),
    cash: n(s.cash),
    deployed: n(s.deployed),
    benchmarkValue: maybe(s.benchmark_value),
  }));
}

export async function getReflections() {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("reflections")
    .select("*")
    .order("created_at", { ascending: false });

  return (data ?? []).map((r: any) => ({
    id: r.id as string,
    bookId: r.book_id as string,
    createdAt: r.created_at as string,
    summary: r.summary as string,
    commitSha: r.commit_sha as string | null,
    rulesAdded: (r.rules_added ?? []) as string[],
    rulesRetired: (r.rules_retired ?? []) as string[],
    tradesCovered: (r.trades_covered ?? []) as string[],
  }));
}

export function unrealisedPct(
  position: { direction: "long" | "short"; entryPrice: number },
  mark: number | null,
): number | null {
  if (mark === null) return null;
  const move = ((mark - position.entryPrice) / position.entryPrice) * 100;
  return position.direction === "long" ? move : -move;
}
