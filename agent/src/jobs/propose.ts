import type { Market } from "@quantrade/core";
import { computeFeatures, rankCandidates, buildDigest, type SymbolFeatures } from "@quantrade/signals";
import { validateProposal } from "@quantrade/portfolio";
import type { MarketAdapter, Instrument } from "@quantrade/market";
import type { Db } from "@quantrade/db";
import { askForProposals, type LlmProvider } from "../llm/client.js";
import { buildProposalPrompt } from "../llm/prompts.js";

export const CANDIDATE_LIMIT = 15;
const HISTORY_DAYS = 400;

export interface ProposeDeps {
  db: Db;
  data: MarketAdapter;
  providers: LlmProvider[];
  agentMd: string;
  universe: Instrument[];
  notify: (message: string) => Promise<void>;
  /** Deadline for a decision; proposals expire at this instant. */
  expiresAt: string;
}

export interface ProposeResult {
  status: "ok" | "failed";
  proposed: number;
  engineRejected: number;
  dropped: string[];
  noTradeReason?: string;
  error?: string;
}

function isoDaysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function runPropose(
  deps: ProposeDeps,
  market: Market,
  asOfDate: string,
): Promise<ProposeResult> {
  const bookId = market === "NSE" ? "nse-main" : "us-main";
  const runId = await deps.db.startRun(bookId, "propose");

  try {
    await deps.db.expireStaleProposals(bookId, new Date().toISOString());

    const book = await deps.db.getBook(bookId);
    const open = await deps.db.getOpenPositions(bookId);
    const from = isoDaysBefore(asOfDate, HISTORY_DAYS);

    // 1. Refresh the bar cache, fetching only the tail we are missing.
    const featureList: SymbolFeatures[] = [];
    for (const inst of deps.universe) {
      const cached = await deps.db.getBars(inst.symbol, from, asOfDate);
      const lastCached = cached.at(-1)?.date;

      let bars = cached;
      if (!lastCached || lastCached < asOfDate) {
        const fetched = await deps.data.dailyBars(
          inst.symbol,
          lastCached ? lastCached : from,
          asOfDate,
        );
        const fresh = fetched.filter((b) => !lastCached || b.date > lastCached);
        if (fresh.length > 0) {
          await deps.db.upsertBars(fresh);
          bars = [...cached, ...fresh];
        }
      }

      const features = computeFeatures(bars, inst.sector);
      if (features) featureList.push(features);
    }

    // 2. Narrow deterministically before the model sees anything.
    const candidates = rankCandidates(featureList, CANDIDATE_LIMIT);
    const allowed = new Set(candidates.map((c) => c.symbol));

    // 3. News for the survivors only.
    const news: Record<string, Array<{ title: string; publisher: string }>> = {};
    for (const c of candidates) {
      try {
        const items = await deps.data.news(c.symbol, isoDaysBefore(asOfDate, 7));
        news[c.symbol] = items.slice(0, 3).map((n) => ({ title: n.title, publisher: n.publisher }));
      } catch {
        news[c.symbol] = []; // missing headlines must not fail the run
      }
    }

    const closed = await deps.db.getClosedPositions(bookId, 10);

    const { system, user } = buildProposalPrompt({
      agentMd: deps.agentMd,
      market,
      asOfDate,
      digest: buildDigest(candidates),
      news,
      cash: book.cash,
      currency: book.currency,
      openPositions: open.map((p) => ({
        symbol: p.symbol,
        direction: p.direction,
        sessionsHeld: 0,
        unrealisedPct: 0,
      })),
      recentOutcomes: closed.map((p) => ({
        symbol: p.symbol,
        netPct: p.netPnl && p.qty && p.entryPrice ? (p.netPnl / (p.qty * p.entryPrice)) * 100 : 0,
        exitReason: p.exitReason ?? "unknown",
        category: "n/a",
      })),
    });

    const { response, model, tokens } = await askForProposals(deps.providers, system, user);

    // 4. Drop hallucinated symbols. This is the only thing standing between the
    //    model and a position in a company that does not exist.
    const dropped: string[] = [];
    const surviving = response.proposals.filter((p) => {
      if (allowed.has(p.symbol)) return true;
      dropped.push(p.symbol);
      return false;
    });

    // 5. Pre-check risk limits so the agent learns the constraint tomorrow
    //    instead of rediscovering it.
    const byCandidate = new Map(candidates.map((c) => [c.symbol, c]));
    const rows = surviving.map((p) => {
      const feature = byCandidate.get(p.symbol)!;
      const verdict = validateProposal({
        market,
        symbol: p.symbol,
        direction: p.direction,
        entryPrice: feature.close, // previous close stands in until the open is known
        stopLoss: p.stop_loss,
        target: p.target,
        sector: feature.sector,
        equity: book.startingCapital,
        cash: book.cash,
        openPositions: open,
      });

      return {
        run_id: runId,
        book_id: bookId,
        symbol: p.symbol,
        direction: p.direction,
        conviction: p.conviction,
        stop_loss: p.stop_loss,
        target: p.target,
        max_hold_sessions: p.max_hold_sessions,
        thesis: p.thesis,
        rules_applied: p.rules_applied,
        falsifier: p.what_would_falsify_this,
        signals_snapshot: feature as unknown,
        status: verdict.ok ? "pending" : "engine_rejected",
        engine_reject_reason: verdict.ok ? null : verdict.reason,
        expires_at: deps.expiresAt,
      };
    });

    await deps.db.insertProposals(rows);

    const pending = rows.filter((r) => r.status === "pending").length;
    const engineRejected = rows.length - pending;

    if (pending > 0) {
      await deps.notify(
        `*${market}* — ${pending} proposal${pending === 1 ? "" : "s"} awaiting your decision.`,
      );
    }

    await deps.db.finishRun(runId, "ok", { model, tokens });

    return {
      status: "ok",
      proposed: pending,
      engineRejected,
      dropped,
      ...(response.no_trade_reason ? { noTradeReason: response.no_trade_reason } : {}),
    };
  } catch (err) {
    const message = (err as Error).message;
    await deps.db.finishRun(runId, "failed", { error: message });
    await deps.notify(`*${market}* propose run failed: ${message}`);
    // Never rethrow: a crashed workflow gives a red tick and no explanation.
    return { status: "failed", proposed: 0, engineRejected: 0, dropped: [], error: message };
  }
}
