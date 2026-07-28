import { describe, it, expect } from "vitest";
import { parseAgentDoc } from "../src/agentmd/parse.js";
import { renderAgentDoc } from "../src/agentmd/render.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "..", "..", "AGENT.md"), "utf8");

const WITH_RULES = `# QuanTrade Agent

## Core Mandate

Do not break these.

## Market Beliefs

- NSE gaps above 2% on earnings day mean-revert within 3 sessions.
- US large caps below their 200-day rarely reclaim it inside a week.

## Active Rules

### R-001 — Avoid longs into NSE earnings within 3 sessions
- **Born:** 2026-08-14
- **Evidence:** T-041, T-047, T-052, T-058, T-061
- **Since born:** 9 applications, 6 wins, +2.1% avg
- **Status:** active

### R-004 — Require volume above 1.5x on any breakout thesis
- **Born:** 2026-09-02
- **Evidence:** T-070, T-071, T-075, T-080, T-088
- **Since born:** 4 applications, 1 wins, -0.8% avg
- **Status:** probation

## Known Failure Modes

- I over-trade the first session after a losing streak.

## Retired Rules

_None yet._
`;

describe("parseAgentDoc", () => {
  it("parses the shipped AGENT.md without throwing", () => {
    const doc = parseAgentDoc(SOURCE);
    expect(doc.coreMandate).toContain("Every proposal carries a stop loss");
    expect(doc.rules).toEqual([]);
  });

  it("extracts rules with all their metadata", () => {
    const doc = parseAgentDoc(WITH_RULES);
    expect(doc.rules).toHaveLength(2);
    const r1 = doc.rules[0]!;
    expect(r1.id).toBe("R-001");
    expect(r1.title).toBe("Avoid longs into NSE earnings within 3 sessions");
    expect(r1.born).toBe("2026-08-14");
    expect(r1.evidence).toHaveLength(5);
    expect(r1.applications).toBe(9);
    expect(r1.wins).toBe(6);
    expect(r1.avgReturn).toBe(2.1);
    expect(r1.status).toBe("active");
  });

  it("reads a negative average return and a probation status", () => {
    const r2 = parseAgentDoc(WITH_RULES).rules[1]!;
    expect(r2.avgReturn).toBe(-0.8);
    expect(r2.status).toBe("probation");
  });

  it("extracts beliefs and failure modes as lists", () => {
    const doc = parseAgentDoc(WITH_RULES);
    expect(doc.beliefs).toHaveLength(2);
    expect(doc.failureModes).toHaveLength(1);
  });

  it("treats placeholder text as an empty list, not an item", () => {
    const doc = parseAgentDoc(SOURCE);
    expect(doc.beliefs).toEqual([]);
    expect(doc.failureModes).toEqual([]);
  });

  it("throws when the Core Mandate heading is missing", () => {
    expect(() => parseAgentDoc("# X\n\n## Active Rules\n")).toThrow(/core mandate/i);
  });

  it("parses retired rules with their reason", () => {
    const withRetired = WITH_RULES.replace(
      "## Retired Rules\n\n_None yet._",
      `## Retired Rules

### ~~R-002 — A disproved idea~~
- **Born:** 2026-08-01
- **Evidence:** T-001, T-002, T-003, T-004, T-005
- **Since born:** 14 applications, 3 wins, -1.9% avg
- **Retired:** 2026-10-01 — hit rate 21% after 14 applications`,
    );
    const doc = parseAgentDoc(withRetired);
    const retired = doc.rules.find((r) => r.id === "R-002")!;
    expect(retired.status).toBe("retired");
    expect(retired.retiredReason).toMatch(/hit rate 21%/);
  });
});

describe("render round-trip", () => {
  it("survives parse -> render -> parse unchanged", () => {
    const once = parseAgentDoc(WITH_RULES);
    const twice = parseAgentDoc(renderAgentDoc(once));
    expect(twice).toEqual(once);
  });

  it("round-trips the shipped AGENT.md", () => {
    const once = parseAgentDoc(SOURCE);
    const twice = parseAgentDoc(renderAgentDoc(once));
    expect(twice.beliefs).toEqual(once.beliefs);
    expect(twice.rules).toEqual(once.rules);
    expect(twice.failureModes).toEqual(once.failureModes);
  });

  it("preserves the Core Mandate byte for byte", () => {
    const doc = parseAgentDoc(WITH_RULES);
    expect(renderAgentDoc(doc)).toContain(doc.coreMandate.trim());
  });

  it("round-trips a document containing retired rules", () => {
    const doc = parseAgentDoc(WITH_RULES);
    doc.rules[1] = { ...doc.rules[1]!, status: "retired", retiredReason: "stopped working" };
    const again = parseAgentDoc(renderAgentDoc(doc));
    const r = again.rules.find((x) => x.id === "R-004")!;
    expect(r.status).toBe("retired");
    expect(r.retiredReason).toBe("stopped working");
  });
});
