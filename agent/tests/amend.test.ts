import { describe, it, expect } from "vitest";
import { applyAmendment } from "../src/agentmd/amend.js";
import type { AgentDoc, Rule } from "../src/agentmd/types.js";

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: "R-001", title: "A rule", born: "2026-08-01",
    evidence: ["T-1", "T-2", "T-3", "T-4", "T-5"],
    applications: 10, wins: 6, avgReturn: 1.2, status: "active",
    ...over,
  };
}

function doc(over: Partial<AgentDoc> = {}): AgentDoc {
  return { coreMandate: "IMMUTABLE", beliefs: [], rules: [], failureModes: [], ...over };
}

const ctx = { today: "2026-09-01", reflectionNumber: 4 };
const FIVE = ["T-1", "T-2", "T-3", "T-4", "T-5"];

describe("evidence floor", () => {
  it("accepts a new rule backed by five closed trades", () => {
    const r = applyAmendment(doc(), { addRules: [{ title: "New rule", evidence: FIVE }] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.rules).toHaveLength(1);
      expect(r.doc.rules[0]!.id).toBe("R-001");
      expect(r.doc.rules[0]!.born).toBe("2026-09-01");
      expect(r.rulesAdded).toEqual(["R-001"]);
    }
  });

  it("refuses a rule backed by four", () => {
    const r = applyAmendment(
      doc(), { addRules: [{ title: "Anecdote", evidence: ["T-1", "T-2", "T-3", "T-4"] }] }, ctx,
    );
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/at least 5/i) });
  });

  it("refuses the whole amendment if any one rule is under-evidenced", () => {
    const r = applyAmendment(
      doc(),
      { addRules: [{ title: "Good", evidence: FIVE }, { title: "Bad", evidence: ["T-9"] }] },
      ctx,
    );
    expect(r.ok).toBe(false);
  });
});

describe("rule cap", () => {
  const fifteen = Array.from({ length: 15 }, (_, i) =>
    rule({ id: `R-${String(i + 1).padStart(3, "0")}` }),
  );

  it("refuses a sixteenth active rule", () => {
    const r = applyAmendment(
      doc({ rules: fifteen }), { addRules: [{ title: "One too many", evidence: FIVE }] }, ctx,
    );
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/cap of 15/i) });
  });

  it("accepts an addition paired with a retirement", () => {
    const r = applyAmendment(
      doc({ rules: fifteen }),
      { addRules: [{ title: "Replacement", evidence: FIVE }], retireRuleIds: ["R-001"] },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.rules.filter((x) => x.status !== "retired")).toHaveLength(15);
      expect(r.doc.rules.find((x) => x.id === "R-001")!.status).toBe("retired");
      expect(r.rulesRetired).toContain("R-001");
    }
  });

  it("never reuses a retired rule's id", () => {
    const r = applyAmendment(
      doc({ rules: [rule({ id: "R-001", status: "retired" })] }),
      { addRules: [{ title: "Next", evidence: FIVE }] },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.rules.some((x) => x.id === "R-002")).toBe(true);
  });

  it("counts retired rules against the id sequence but not the cap", () => {
    const rules = [
      ...Array.from({ length: 10 }, (_, i) => rule({ id: `R-${String(i + 1).padStart(3, "0")}`, status: "retired" })),
      ...Array.from({ length: 5 }, (_, i) => rule({ id: `R-${String(i + 11).padStart(3, "0")}` })),
    ];
    const r = applyAmendment(doc({ rules }), { addRules: [{ title: "Fine", evidence: FIVE }] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rulesAdded).toEqual(["R-016"]);
  });
});

describe("automatic probation", () => {
  it("demotes an active rule below a 45% hit rate over 10+ applications", () => {
    const weak = rule({ id: "R-002", applications: 12, wins: 4 }); // 33%
    const r = applyAmendment(doc({ rules: [weak] }), {}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.rules[0]!.status).toBe("probation");
  });

  it("leaves a weak rule alone below 10 applications", () => {
    const young = rule({ id: "R-002", applications: 6, wins: 1 });
    const r = applyAmendment(doc({ rules: [young] }), {}, ctx);
    if (r.ok) expect(r.doc.rules[0]!.status).toBe("active");
  });

  it("retires a rule that fails again while on probation", () => {
    const failing = rule({ id: "R-002", applications: 20, wins: 6, status: "probation" });
    const r = applyAmendment(doc({ rules: [failing] }), {}, ctx);
    if (r.ok) {
      expect(r.doc.rules[0]!.status).toBe("retired");
      expect(r.rulesRetired).toContain("R-002");
    }
  });

  it("restores a probation rule that recovers", () => {
    const recovered = rule({ id: "R-002", applications: 20, wins: 14, status: "probation" });
    const r = applyAmendment(doc({ rules: [recovered] }), {}, ctx);
    if (r.ok) expect(r.doc.rules[0]!.status).toBe("active");
  });

  it("runs the review even when the model proposes nothing at all", () => {
    const weak = rule({ id: "R-002", applications: 30, wins: 5 });
    const r = applyAmendment(doc({ rules: [weak] }), {}, ctx);
    if (r.ok) expect(r.doc.rules[0]!.status).toBe("probation");
  });
});

describe("core mandate immutability", () => {
  it("carries the mandate through untouched", () => {
    const r = applyAmendment(doc({ coreMandate: "IMMUTABLE" }), { addBeliefs: ["x"] }, ctx);
    if (r.ok) expect(r.doc.coreMandate).toBe("IMMUTABLE");
  });

  it("has no amendment field capable of reaching it", () => {
    // Structural, not instructional: even a hostile payload has nowhere to land.
    const hostile = { coreMandate: "hacked", core_mandate: "hacked" } as never;
    const r = applyAmendment(doc({ coreMandate: "IMMUTABLE" }), hostile, ctx);
    if (r.ok) expect(r.doc.coreMandate).toBe("IMMUTABLE");
  });
});

describe("beliefs and failure modes", () => {
  it("adds and removes beliefs", () => {
    const r = applyAmendment(
      doc({ beliefs: ["old"] }), { addBeliefs: ["new"], removeBeliefs: ["old"] }, ctx,
    );
    if (r.ok) expect(r.doc.beliefs).toEqual(["new"]);
  });

  it("caps beliefs at 20 to stop unbounded accretion", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `belief ${i}`);
    const r = applyAmendment(doc({ beliefs: twenty }), { addBeliefs: ["one more"] }, ctx);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/cap of 20/i) });
  });

  it("allows swapping a belief at the cap", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `belief ${i}`);
    const r = applyAmendment(
      doc({ beliefs: twenty }), { addBeliefs: ["fresh"], removeBeliefs: ["belief 0"] }, ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.beliefs).toHaveLength(20);
  });

  it("appends failure modes", () => {
    const r = applyAmendment(doc(), { addFailureModes: ["I chase gaps"] }, ctx);
    if (r.ok) expect(r.doc.failureModes).toEqual(["I chase gaps"]);
  });
});
