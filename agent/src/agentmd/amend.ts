import type { AgentDoc, AmendContext, Amendment, Rule } from "./types.js";

export const MAX_ACTIVE_RULES = 15;
export const MAX_BELIEFS = 20;
export const MAX_FAILURE_MODES = 15;
export const MIN_EVIDENCE = 5;
export const PROBATION_HIT_RATE = 0.45;
export const MIN_APPLICATIONS_TO_JUDGE = 10;

export type AmendResult =
  | { ok: true; doc: AgentDoc; rulesAdded: string[]; rulesRetired: string[] }
  | { ok: false; reason: string };

function nextRuleId(rules: Rule[]): string {
  // Include retired rules so an id is never reused — a recycled id would make
  // the evidence trail in old reflections point at the wrong belief.
  const highest = rules.reduce((max, r) => {
    const n = Number(r.id.slice(2));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `R-${String(highest + 1).padStart(3, "0")}`;
}

/**
 * Re-evaluate a rule's status from its own hit rate. Done in code rather than
 * asked of the model, because a model that is merely instructed to demote its
 * own failing ideas will find reasons not to.
 */
function reviewStatus(rule: Rule): Rule {
  if (rule.status === "retired") return rule;
  if (rule.applications < MIN_APPLICATIONS_TO_JUDGE) return rule;

  const hitRate = rule.wins / rule.applications;

  if (hitRate < PROBATION_HIT_RATE) {
    // Already on probation and still failing: retire it.
    return rule.status === "probation"
      ? { ...rule, status: "retired", retiredReason: `hit rate ${(hitRate * 100).toFixed(0)}% after ${rule.applications} applications` }
      : { ...rule, status: "probation" };
  }

  // Recovered while on probation.
  return rule.status === "probation" ? { ...rule, status: "active" } : rule;
}

export function applyAmendment(
  doc: AgentDoc,
  amendment: Amendment,
  ctx: AmendContext,
): AmendResult {
  const rulesRetired: string[] = [];
  const rulesAdded: string[] = [];

  // 1. Explicit retirements requested by the reflection.
  let rules = doc.rules.map((r) => {
    if (amendment.retireRuleIds?.includes(r.id) && r.status !== "retired") {
      rulesRetired.push(r.id);
      return { ...r, status: "retired" as const, retiredReason: `retired at reflection #${ctx.reflectionNumber}` };
    }
    return r;
  });

  // 2. Automatic status review from hit rates.
  rules = rules.map((r) => {
    const reviewed = reviewStatus(r);
    if (reviewed.status === "retired" && r.status !== "retired") rulesRetired.push(r.id);
    return reviewed;
  });

  // 3. Validate additions against the evidence floor and the active cap.
  const additions = amendment.addRules ?? [];
  for (const candidate of additions) {
    if (candidate.evidence.length < MIN_EVIDENCE) {
      return {
        ok: false,
        reason:
          `Rule "${candidate.title}" is backed by ${candidate.evidence.length} trades; ` +
          `a new rule needs at least ${MIN_EVIDENCE}.`,
      };
    }
  }

  const activeCount = rules.filter((r) => r.status !== "retired").length;
  if (activeCount + additions.length > MAX_ACTIVE_RULES) {
    return {
      ok: false,
      reason:
        `That would leave ${activeCount + additions.length} active rules, above the cap of ` +
        `${MAX_ACTIVE_RULES}. Retire a rule in the same amendment to make room.`,
    };
  }

  // 4. Mint the new rules.
  for (const candidate of additions) {
    const id = nextRuleId(rules);
    rules = [
      ...rules,
      {
        id,
        title: candidate.title,
        born: ctx.today,
        evidence: candidate.evidence,
        applications: 0,
        wins: 0,
        avgReturn: 0,
        status: "active",
      },
    ];
    rulesAdded.push(id);
  }

  // 5. Beliefs and failure modes.
  const removals = new Set(amendment.removeBeliefs ?? []);
  const beliefs = [
    ...doc.beliefs.filter((b) => !removals.has(b)),
    ...(amendment.addBeliefs ?? []),
  ];
  if (beliefs.length > MAX_BELIEFS) {
    return {
      ok: false,
      reason: `That would leave ${beliefs.length} beliefs, above the cap of ${MAX_BELIEFS}. Remove one first.`,
    };
  }

  const failureModes = [...doc.failureModes, ...(amendment.addFailureModes ?? [])];
  if (failureModes.length > MAX_FAILURE_MODES) {
    return {
      ok: false,
      reason: `That would leave ${failureModes.length} failure modes, above the cap of ${MAX_FAILURE_MODES}.`,
    };
  }

  // 6. Core Mandate is copied across verbatim. There is no code path by which
  //    an amendment can reach it.
  return {
    ok: true,
    doc: { coreMandate: doc.coreMandate, beliefs, rules, failureModes },
    rulesAdded,
    rulesRetired: [...new Set(rulesRetired)],
  };
}
