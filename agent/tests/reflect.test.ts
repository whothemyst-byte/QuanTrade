import { describe, it, expect, vi } from "vitest";
import { runReflect, type PostMortemRecord } from "../src/jobs/reflect.js";
import { parseAgentDoc } from "../src/agentmd/parse.js";

const BASE_MD = `# QuanTrade Agent

## Core Mandate

Never break these. Every proposal carries a stop loss.

## Market Beliefs

_No beliefs recorded yet._

## Active Rules

_No rules yet._

## Known Failure Modes

_None recorded yet._

## Retired Rules

_None yet._
`;

const FIVE = ["T-1", "T-2", "T-3", "T-4", "T-5"];

function pm(over: Partial<PostMortemRecord> = {}): PostMortemRecord {
  return {
    positionId: "pos-1", symbol: "AAPL", category: "thesis_wrong",
    netPct: -2.1, lesson: "I chased a gap.",
    ...over,
  };
}

function makeDeps(over: {
  llm?: unknown;
  postMortems?: PostMortemRecord[];
  md?: string;
  commitThrows?: boolean;
} = {}) {
  const state = { written: [] as string[], reflections: [] as any[], commits: [] as any[] };

  const db = {
    startRun: vi.fn(async () => "run-1"),
    finishRun: vi.fn(async () => {}),
    insertReflection: vi.fn(async (r: any) => { state.reflections.push(r); }),
  };

  const llmBody = over.llm ?? {
    summary: "Learned to respect volume.",
    add_beliefs: ["Gaps without volume fade."],
    remove_beliefs: [],
    add_rules: [{ title: "Require 1.5x volume on breakouts", evidence: FIVE }],
    retire_rule_ids: [],
    add_failure_modes: [],
  };

  const notify = vi.fn(async () => {});

  return {
    state, db, notify,
    deps: {
      db,
      providers: [{
        name: "fake",
        complete: vi.fn(async () => ({ text: JSON.stringify(llmBody), tokens: 200 })),
      }],
      readAgentMd: vi.fn(async () => over.md ?? BASE_MD),
      writeAgentMd: vi.fn(async (c: string) => { state.written.push(c); }),
      commit: vi.fn(async (m: string, b: string) => {
        if (over.commitThrows) throw new Error("nothing to commit");
        state.commits.push({ m, b });
        return "abc1234def5678";
      }),
      loadPostMortems: vi.fn(async () => over.postMortems ?? [pm()]),
      reflectionNumber: 1,
      today: "2026-09-01",
      notify,
    } as never,
  };
}

describe("runReflect", () => {
  it("amends AGENT.md and commits with the summary in the body", async () => {
    const { deps, state } = makeDeps();
    const r = await runReflect(deps, "US");
    expect(r.status).toBe("ok");
    expect(state.written).toHaveLength(1);
    expect(state.commits[0].m).toMatch(/reflection #1 \(US\)/);
    expect(state.commits[0].b).toMatch(/Learned to respect volume/);
    expect(state.written[0]).toContain("Require 1.5x volume on breakouts");
  });

  it("records the commit SHA on the reflections row", async () => {
    const { deps, state } = makeDeps();
    const r = await runReflect(deps, "US");
    expect(r.commitSha).toBe("abc1234def5678");
    expect(state.reflections[0].commit_sha).toBe("abc1234def5678");
    expect(state.reflections[0].rules_added).toEqual(["R-001"]);
  });

  it("refuses an amendment that breaches the evidence floor and commits nothing", async () => {
    const { deps, state } = makeDeps({
      llm: {
        summary: "s", add_beliefs: [], remove_beliefs: [],
        add_rules: [{ title: "Anecdote", evidence: ["T-1"] }],
        retire_rule_ids: [], add_failure_modes: [],
      },
    });
    const r = await runReflect(deps, "US");
    expect(r.status).toBe("refused");
    expect(state.written).toHaveLength(0);
    expect(state.commits).toHaveLength(0);
    // The blocked attempt is still visible rather than silent.
    expect(state.reflections[0].summary).toMatch(/refused by guardrails/i);
    expect(state.reflections[0].commit_sha).toBeNull();
  });

  it("leaves the Core Mandate byte-identical in what it writes", async () => {
    const { deps, state } = makeDeps();
    await runReflect(deps, "US");
    const before = parseAgentDoc(BASE_MD).coreMandate;
    const after = parseAgentDoc(state.written[0]!).coreMandate;
    expect(after).toBe(before);
  });

  it("excludes unmodelled_event trades from what the model sees", async () => {
    const { deps } = makeDeps({
      postMortems: [
        pm({ positionId: "keep-1", category: "thesis_wrong" }),
        pm({ positionId: "drop-1", category: "unmodelled_event", lesson: "war broke out" }),
      ],
    });
    await runReflect(deps, "US");
    const userPrompt = ((deps as any).providers[0].complete as any).mock.calls[0][1] as string;
    expect(userPrompt).not.toMatch(/war broke out/);
    expect(userPrompt).toMatch(/I chased a gap/);
  });

  it("does not count unmodelled_event trades as covered", async () => {
    const { deps, state } = makeDeps({
      postMortems: [
        pm({ positionId: "keep-1" }),
        pm({ positionId: "drop-1", category: "unmodelled_event" }),
      ],
    });
    await runReflect(deps, "US");
    expect(state.reflections[0].trades_covered).toEqual(["keep-1"]);
  });

  it("applies automatic probation even when the model proposes nothing", async () => {
    const withWeakRule = BASE_MD.replace(
      "## Active Rules\n\n_No rules yet._",
      `## Active Rules

### R-001 — A failing rule
- **Born:** 2026-08-01
- **Evidence:** T-1, T-2, T-3, T-4, T-5
- **Since born:** 20 applications, 4 wins, -1.5% avg
- **Status:** active`,
    );
    const { deps, state } = makeDeps({
      md: withWeakRule,
      llm: {
        summary: "Nothing to add.", add_beliefs: [], remove_beliefs: [],
        add_rules: [], retire_rule_ids: [], add_failure_modes: [],
      },
    });
    const r = await runReflect(deps, "US");
    expect(r.status).toBe("ok");
    expect(state.written[0]).toMatch(/\*\*Status:\*\* probation/);
  });

  it("reports unchanged and skips the commit when nothing moved", async () => {
    const { deps, state } = makeDeps({
      md: BASE_MD,
      llm: {
        summary: "No change.", add_beliefs: [], remove_beliefs: [],
        add_rules: [], retire_rule_ids: [], add_failure_modes: [],
      },
    });
    const r = await runReflect(deps, "US");
    expect(r.status).toBe("unchanged");
    expect(state.commits).toHaveLength(0);
  });

  it("fails cleanly when the commit itself fails", async () => {
    const { deps } = makeDeps({ commitThrows: true });
    const r = await runReflect(deps, "US");
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/nothing to commit/);
  });

  it("never throws", async () => {
    const { deps } = makeDeps();
    (deps as any).readAgentMd = vi.fn(async () => { throw new Error("fs gone"); });
    await expect(runReflect(deps, "US")).resolves.toMatchObject({ status: "failed" });
  });
});
