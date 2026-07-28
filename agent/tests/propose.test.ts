import { describe, it, expect, vi } from "vitest";
import { runPropose } from "../src/jobs/propose.js";
import type { Bar } from "@quantrade/core";

function bars(symbol: string, n = 300): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * 0.1;
    const d = new Date(Date.UTC(2025, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    return {
      symbol, date: d.toISOString().slice(0, 10),
      open: close - 0.05, high: close + 1, low: close - 1, close,
      volume: 1000 + (i === n - 1 ? 5000 : 0),
    };
  });
}

const LLM_OK = JSON.stringify({
  market_view: "Trending.",
  proposals: [{
    symbol: "AAPL", direction: "long", conviction: 0.7,
    stop_loss: 100, target: 200, max_hold_sessions: 7,
    thesis: "t", rules_applied: [], what_would_falsify_this: "f",
  }],
});

function makeDeps(over: { llm?: string; dailyBars?: unknown; dbOver?: Record<string, unknown> } = {}) {
  const inserted: any[] = [];
  const notify = vi.fn(async () => {});
  const finishRun = vi.fn(async () => {});

  const db = {
    startRun: vi.fn(async () => "run-1"),
    finishRun,
    expireStaleProposals: vi.fn(async () => 0),
    getBook: vi.fn(async () => ({
      id: "us-main", market: "US", currency: "USD",
      startingCapital: 999999, cash: 999999,
    })),
    getBars: vi.fn(async () => []),
    upsertBars: vi.fn(async () => {}),
    getOpenPositions: vi.fn(async () => []),
    getClosedPositions: vi.fn(async () => []),
    insertProposals: vi.fn(async (rows: any[]) => { inserted.push(...rows); }),
    ...over.dbOver,
  };

  const data = {
    name: "fake",
    dailyBars: over.dailyBars ?? vi.fn(async (symbol: string) => bars(symbol)),
    news: vi.fn(async () => []),
  };

  const providers = [{
    name: "fake-llm",
    complete: vi.fn(async () => ({ text: over.llm ?? LLM_OK, tokens: 500 })),
  }];

  return {
    inserted, notify, db,
    deps: {
      db, data, providers,
      agentMd: "# Agent\n\n## Core Mandate\n\nRules.\n",
      universe: [
        { symbol: "AAPL", name: "Apple", sector: "Technology" },
        { symbol: "MSFT", name: "Microsoft", sector: "Technology" },
      ],
      notify,
      expiresAt: "2026-07-29T13:15:00.000Z",
    } as never,
  };
}

describe("runPropose", () => {
  it("persists proposals returned by the agent", async () => {
    const { deps, inserted } = makeDeps();
    const r = await runPropose(deps, "US", "2026-07-28");
    expect(r.status).toBe("ok");
    expect(inserted).toHaveLength(1);
    expect(inserted[0].symbol).toBe("AAPL");
    expect(inserted[0].status).toBe("pending");
    expect(inserted[0].expires_at).toBe("2026-07-29T13:15:00.000Z");
  });

  it("stores the signals snapshot alongside each proposal", async () => {
    const { deps, inserted } = makeDeps();
    await runPropose(deps, "US", "2026-07-28");
    expect(inserted[0].signals_snapshot).toBeTruthy();
    expect(inserted[0].signals_snapshot.symbol).toBe("AAPL");
  });

  it("caches freshly fetched bars", async () => {
    const { deps, db } = makeDeps();
    await runPropose(deps, "US", "2026-07-28");
    expect(db.upsertBars).toHaveBeenCalled();
  });

  it("drops a proposal for a symbol that was never a candidate", async () => {
    const { deps, inserted } = makeDeps({
      llm: JSON.stringify({
        market_view: "x",
        proposals: [{
          symbol: "TSLA", direction: "long", conviction: 0.9,
          stop_loss: 100, target: 200, max_hold_sessions: 5,
          thesis: "t", rules_applied: [], what_would_falsify_this: "f",
        }],
      }),
    });
    const r = await runPropose(deps, "US", "2026-07-28");
    expect(inserted).toHaveLength(0);
    expect(r.dropped).toContain("TSLA");
  });

  it("records engine_rejected instead of pending when a limit is breached", async () => {
    const { deps, inserted } = makeDeps({
      llm: JSON.stringify({
        market_view: "x",
        proposals: [{
          // Stop above the last close makes this an invalid long.
          symbol: "AAPL", direction: "long", conviction: 0.9,
          stop_loss: 9999, target: 99999, max_hold_sessions: 5,
          thesis: "t", rules_applied: [], what_would_falsify_this: "f",
        }],
      }),
    });
    const r = await runPropose(deps, "US", "2026-07-28");
    expect(inserted[0].status).toBe("engine_rejected");
    expect(inserted[0].engine_reject_reason).toMatch(/stop/i);
    expect(r.engineRejected).toBe(1);
  });

  it("records a clean no-trade day without inserting anything", async () => {
    const { deps, inserted, notify } = makeDeps({
      llm: JSON.stringify({
        market_view: "Nothing here.",
        proposals: [],
        no_trade_reason: "No candidate cleared the volume filter.",
      }),
    });
    const r = await runPropose(deps, "US", "2026-07-28");
    expect(r.status).toBe("ok");
    expect(r.noTradeReason).toMatch(/volume filter/);
    expect(inserted).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("marks the run failed and notifies when data collection breaks", async () => {
    const { deps, notify, db } = makeDeps({
      dailyBars: vi.fn(async () => { throw new Error("Yahoo down"); }),
    });
    const r = await runPropose(deps, "US", "2026-07-28");
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Yahoo down/);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/failed/i));
    expect(db.finishRun).toHaveBeenCalledWith("run-1", "failed", expect.anything());
  });

  it("never throws, so the workflow reports the failure rather than crashing", async () => {
    const { deps } = makeDeps({
      dbOver: { getBook: vi.fn(async () => { throw new Error("db gone"); }) },
    });
    await expect(runPropose(deps, "US", "2026-07-28")).resolves.toMatchObject({ status: "failed" });
  });

  it("notifies once when proposals are waiting for a decision", async () => {
    const { deps, notify } = makeDeps();
    await runPropose(deps, "US", "2026-07-28");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/1 proposal/i));
  });

  it("survives a news fetch failure without failing the run", async () => {
    const { deps } = makeDeps();
    (deps as any).data.news = vi.fn(async () => { throw new Error("news down"); });
    const r = await runPropose(deps, "US", "2026-07-28");
    expect(r.status).toBe("ok");
  });

  it("expires stale proposals before proposing again", async () => {
    const { deps, db } = makeDeps();
    await runPropose(deps, "US", "2026-07-28");
    expect(db.expireStaleProposals).toHaveBeenCalled();
  });
});
