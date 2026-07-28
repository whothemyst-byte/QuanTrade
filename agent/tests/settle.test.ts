import { describe, it, expect, vi } from "vitest";
import { runSettle } from "../src/jobs/settle.js";
import type { Bar, Position, Proposal } from "@quantrade/core";

const DATE = "2026-07-28"; // a Tuesday, session day in both markets

function bar(symbol: string, over: Partial<Bar> = {}): Bar {
  return {
    symbol, date: DATE,
    open: 100, high: 104, low: 98, close: 103, volume: 5000,
    ...over,
  };
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "pr-1", bookId: "us-main", symbol: "AAPL", direction: "long",
    conviction: 0.7, stopLoss: 90, target: 130, maxHoldSessions: 5,
    thesis: "t", rulesApplied: [], whatWouldFalsifyThis: "f",
    status: "approved",
    ...over,
  };
}

function position(over: Partial<Position> = {}): Position {
  return {
    id: "pos-1", proposalId: "pr-0", bookId: "us-main",
    symbol: "AAPL", sector: "Technology", direction: "long",
    qty: 100, entryPrice: 100, entryDate: "2026-07-20",
    stopLoss: 90, target: 130, maxHoldSessions: 5,
    status: "open", isShadow: false, entryCosts: 0,
    ...over,
  };
}

const PM_OK = JSON.stringify({
  category: "correct", expected: "e", actual: "a", lesson: "l",
});

function makeDeps(over: {
  open?: Position[];
  decided?: Proposal[];
  bars?: Record<string, Bar[]>;
  closedCount?: number;
  llm?: string;
} = {}) {
  const state = {
    insertedPositions: [] as Position[],
    closedPositions: [] as Position[],
    snapshots: [] as any[],
    postMortems: [] as any[],
    cash: [] as number[],
  };

  const db = {
    startRun: vi.fn(async () => "run-1"),
    finishRun: vi.fn(async () => {}),
    getBook: vi.fn(async () => ({
      id: "us-main", market: "US", currency: "USD",
      startingCapital: 999999, cash: 999999,
    })),
    getOpenPositions: vi.fn(async () => over.open ?? []),
    getUnsettledProposals: vi.fn(async () => over.decided ?? []),
    upsertBars: vi.fn(async () => {}),
    insertPositions: vi.fn(async (p: Position[]) => { state.insertedPositions.push(...p); }),
    closePositions: vi.fn(async (p: Position[]) => { state.closedPositions.push(...p); }),
    updateBookCash: vi.fn(async (_id: string, cash: number) => { state.cash.push(cash); }),
    insertEquitySnapshot: vi.fn(async (s: any, b: any) => { state.snapshots.push({ s, b }); }),
    insertPostMortem: vi.fn(async (pm: any) => { state.postMortems.push(pm); }),
    countClosedSinceLastReflection: vi.fn(async () => over.closedCount ?? 0),
  };

  const barMap = over.bars ?? { AAPL: [bar("AAPL")], SPY: [bar("SPY", { close: 500 })] };

  const data = {
    name: "fake",
    dailyBars: vi.fn(async (symbol: string) => barMap[symbol] ?? []),
    news: vi.fn(async () => []),
  };

  const notify = vi.fn(async () => {});

  return {
    state, db, notify,
    deps: {
      db, data,
      providers: [{ name: "fake", complete: vi.fn(async () => ({ text: over.llm ?? PM_OK, tokens: 50 })) }],
      agentMd: "# A\n\n## Core Mandate\n\nx\n",
      sectors: { AAPL: "Technology", MSFT: "Technology" },
      notify,
    } as never,
  };
}

describe("runSettle — entries", () => {
  it("opens approved proposals as real positions", async () => {
    const { deps, state } = makeDeps({ decided: [proposal()] });
    const r = await runSettle(deps, "US", DATE);
    expect(r.status).toBe("ok");
    expect(state.insertedPositions).toHaveLength(1);
    expect(state.insertedPositions[0]!.isShadow).toBe(false);
  });

  it("opens rejected and expired proposals as shadow positions", async () => {
    const { deps, state } = makeDeps({
      decided: [
        proposal({ id: "pr-r", symbol: "AAPL", status: "rejected" }),
        proposal({ id: "pr-e", symbol: "MSFT", status: "expired" }),
      ],
      bars: { AAPL: [bar("AAPL")], MSFT: [bar("MSFT")], SPY: [bar("SPY")] },
    });
    await runSettle(deps, "US", DATE);
    expect(state.insertedPositions).toHaveLength(2);
    expect(state.insertedPositions.every((p) => p.isShadow)).toBe(true);
  });

  it("does not let shadow positions touch book cash", async () => {
    const { deps, state } = makeDeps({
      decided: [proposal({ id: "pr-r", status: "rejected" })],
    });
    await runSettle(deps, "US", DATE);
    expect(state.cash[0]).toBe(999999);
  });
});

describe("runSettle — exits", () => {
  it("closes a stopped position and writes a post-mortem", async () => {
    const { deps, state } = makeDeps({
      open: [position()],
      bars: { AAPL: [bar("AAPL", { open: 95, high: 96, low: 88, close: 89 })], SPY: [bar("SPY")] },
    });
    await runSettle(deps, "US", DATE);
    expect(state.closedPositions).toHaveLength(1);
    expect(state.closedPositions[0]!.exitReason).toBe("stop");
    expect(state.postMortems).toHaveLength(1);
    expect(state.postMortems[0].category).toBe("correct");
  });

  it("does not write post-mortems for shadow positions", async () => {
    const { deps, state } = makeDeps({
      open: [position({ isShadow: true })],
      bars: { AAPL: [bar("AAPL", { open: 95, high: 96, low: 88, close: 89 })], SPY: [bar("SPY")] },
    });
    await runSettle(deps, "US", DATE);
    expect(state.closedPositions).toHaveLength(1);
    expect(state.postMortems).toHaveLength(0);
  });

  it("still settles when the post-mortem call fails", async () => {
    const { deps, state } = makeDeps({
      open: [position()],
      bars: { AAPL: [bar("AAPL", { open: 95, high: 96, low: 88, close: 89 })], SPY: [bar("SPY")] },
      llm: "not json at all",
    });
    const r = await runSettle(deps, "US", DATE);
    expect(r.status).toBe("ok");
    expect(state.closedPositions).toHaveLength(1);
    expect(state.postMortems).toHaveLength(0);
  });
});

describe("runSettle — snapshots and benchmark", () => {
  it("persists exactly one equity snapshot for the date", async () => {
    const { deps, state } = makeDeps({ open: [position()] });
    await runSettle(deps, "US", DATE);
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0].s.date).toBe(DATE);
  });

  it("records the benchmark value on the snapshot", async () => {
    const { deps, state } = makeDeps({
      open: [position()],
      bars: { AAPL: [bar("AAPL")], SPY: [bar("SPY", { close: 512.5 })] },
    });
    await runSettle(deps, "US", DATE);
    expect(state.snapshots[0].b).toBe(512.5);
  });

  it("still writes the snapshot when the benchmark fetch fails", async () => {
    const { deps, state } = makeDeps({ open: [position()], bars: { AAPL: [bar("AAPL")] } });
    await runSettle(deps, "US", DATE);
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0].b).toBeNull();
  });
});

describe("runSettle — control flow", () => {
  it("skips entirely on a non-session day", async () => {
    const { deps, db } = makeDeps();
    const r = await runSettle(deps, "US", "2026-08-01"); // Saturday
    expect(r.status).toBe("skipped");
    expect(db.startRun).not.toHaveBeenCalled();
  });

  it("fails without writing when a held symbol has no bar", async () => {
    const { deps, state } = makeDeps({ open: [position()], bars: { SPY: [bar("SPY")] } });
    const r = await runSettle(deps, "US", DATE);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/partial settle/i);
    expect(state.insertedPositions).toHaveLength(0);
    expect(state.closedPositions).toHaveLength(0);
    expect(state.snapshots).toHaveLength(0);
  });

  it("triggers a reflection when the book crosses 10 closed trades", async () => {
    const { deps } = makeDeps({ closedCount: 10 });
    const r = await runSettle(deps, "US", DATE);
    expect(r.shouldReflect).toBe(true);
  });

  it("does not trigger a reflection at 9", async () => {
    const { deps } = makeDeps({ closedCount: 9 });
    expect((await runSettle(deps, "US", DATE)).shouldReflect).toBe(false);
  });

  it("never throws", async () => {
    const { deps } = makeDeps();
    (deps as any).db.getBook = vi.fn(async () => { throw new Error("db gone"); });
    await expect(runSettle(deps, "US", DATE)).resolves.toMatchObject({ status: "failed" });
  });
});
