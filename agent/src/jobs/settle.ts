import type { Bar, Market, Position } from "@quantrade/core";
import { isSessionDay, settle, type PendingEntry } from "@quantrade/portfolio";
import type { MarketAdapter } from "@quantrade/market";
import type { Db } from "@quantrade/db";
import { AmendmentResponseSchema } from "../agentmd/types.js";
import { askValidated, type LlmProvider } from "../llm/client.js";
import { buildPostMortemPrompt } from "../llm/prompts.js";
import { z } from "zod";

export const REFLECTION_THRESHOLD = 10;

/** Index used as the buy-and-hold benchmark for each book. */
export const BENCHMARK: Record<Market, string> = { NSE: "^NSEI", US: "SPY" };

const PostMortemSchema = z.object({
  category: z.enum([
    "thesis_wrong",
    "thesis_right_timing_wrong",
    "rule_violated",
    "unmodelled_event",
    "correct",
  ]),
  expected: z.string().min(1),
  actual: z.string().min(1),
  lesson: z.string().min(1),
});

export interface SettleDeps {
  db: Db;
  data: MarketAdapter;
  providers: LlmProvider[];
  agentMd: string;
  sectors: Record<string, string>;
  notify: (message: string) => Promise<void>;
}

export interface SettleResult {
  status: "ok" | "failed" | "skipped";
  opened: number;
  closed: number;
  shouldReflect: boolean;
  error?: string;
}

export async function runSettle(
  deps: SettleDeps,
  market: Market,
  asOfDate: string,
): Promise<SettleResult> {
  const bookId = market === "NSE" ? "nse-main" : "us-main";

  if (!isSessionDay(market, asOfDate)) {
    return { status: "skipped", opened: 0, closed: 0, shouldReflect: false };
  }

  const runId = await deps.db.startRun(bookId, "settle");

  try {
    const book = await deps.db.getBook(bookId);
    const open = await deps.db.getOpenPositions(bookId);
    const decided = await deps.db.getUnsettledProposals(bookId);

    // Rejected and expired proposals still become positions — as shadow trades.
    const pendingEntries: PendingEntry[] = decided.map((proposal) => ({
      proposal,
      sector: deps.sectors[proposal.symbol] ?? "Unknown",
    }));

    // Fetch today's bar for every symbol we need. A partial settle is worse
    // than none: it would mark some positions and not others, then double-count
    // on the retry.
    const symbols = new Set([...open.map((p) => p.symbol), ...decided.map((p) => p.symbol)]);
    const bars: Record<string, Bar> = {};
    const missing: string[] = [];
    for (const symbol of symbols) {
      const fetched = await deps.data.dailyBars(symbol, asOfDate, asOfDate);
      const bar = fetched.find((b) => b.date === asOfDate);
      if (bar) bars[symbol] = bar;
      else missing.push(symbol);
    }
    if (missing.length > 0) {
      throw new Error(`No ${asOfDate} bar for: ${missing.join(", ")}. Refusing a partial settle.`);
    }

    if (Object.keys(bars).length > 0) {
      await deps.db.upsertBars(Object.values(bars));
    }

    const result = settle({
      book, date: asOfDate,
      openPositions: open,
      pendingEntries,
      bars,
      sectors: deps.sectors,
    });

    // Benchmark is best-effort: a missing index quote must not cost the day's
    // equity record, so benchmark_value is nullable and this is isolated.
    let benchmark: number | null = null;
    try {
      const idx = await deps.data.dailyBars(BENCHMARK[market], asOfDate, asOfDate);
      benchmark = idx.find((b) => b.date === asOfDate)?.close ?? null;
    } catch {
      benchmark = null;
    }

    await deps.db.insertPositions(result.opened);
    await deps.db.closePositions(result.closed);
    await deps.db.updateBookCash(bookId, result.book.cash);
    await deps.db.insertEquitySnapshot(result.snapshot, benchmark);

    // Post-mortems for real closed trades only. Shadow trades are measured,
    // not reflected on — they were never the agent's decision to own.
    for (const p of result.closed.filter((x) => !x.isShadow)) {
      await writePostMortem(deps, p);
    }

    const closedCount = await deps.db.countClosedSinceLastReflection(bookId);
    const shouldReflect = closedCount >= REFLECTION_THRESHOLD;

    await deps.db.finishRun(runId, "ok");
    await deps.notify(
      `*${market}* settled ${asOfDate}: ${result.opened.length} opened, ` +
        `${result.closed.length} closed. Equity ${result.snapshot.equity.toLocaleString()}.`,
    );

    return {
      status: "ok",
      opened: result.opened.length,
      closed: result.closed.length,
      shouldReflect,
    };
  } catch (err) {
    const message = (err as Error).message;
    await deps.db.finishRun(runId, "failed", { error: message });
    await deps.notify(`*${market}* settle run failed: ${message}`);
    return { status: "failed", opened: 0, closed: 0, shouldReflect: false, error: message };
  }
}

async function writePostMortem(deps: SettleDeps, p: Position): Promise<void> {
  const notional = p.qty * p.entryPrice;
  const { system, user } = buildPostMortemPrompt({
    agentMd: deps.agentMd,
    symbol: p.symbol,
    direction: p.direction,
    thesis: "(recorded on the proposal)",
    falsifier: "(recorded on the proposal)",
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice ?? 0,
    exitReason: p.exitReason ?? "unknown",
    netPct: notional ? ((p.netPnl ?? 0) / notional) * 100 : 0,
    sessionsHeld: p.maxHoldSessions,
  });

  try {
    const { response } = await askValidated(deps.providers, PostMortemSchema, system, user);
    await deps.db.insertPostMortem({
      position_id: p.id,
      category: response.category,
      expected: response.expected,
      actual: response.actual,
      lesson: response.lesson,
    });
  } catch {
    // A missing post-mortem costs the learning loop one data point. Failing the
    // whole settle over it would cost the ledger a day.
  }
}
