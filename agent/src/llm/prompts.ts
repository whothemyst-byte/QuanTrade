import type { Market } from "@quantrade/core";

export interface ProposalPromptInput {
  agentMd: string;
  market: Market;
  asOfDate: string;
  digest: string;
  news: Record<string, Array<{ title: string; publisher: string }>>;
  cash: number;
  currency: string;
  openPositions: Array<{ symbol: string; direction: string; sessionsHeld: number; unrealisedPct: number }>;
  recentOutcomes: Array<{ symbol: string; netPct: number; exitReason: string; category: string }>;
}

export function buildProposalPrompt(input: ProposalPromptInput): { system: string; user: string } {
  const system = [
    input.agentMd,
    "",
    "## Output contract",
    "",
    "Respond with JSON only. No prose outside the JSON object.",
    "",
    "{",
    '  "market_view": "one short paragraph on regime and posture",',
    '  "proposals": [{',
    '    "symbol": "exactly as written in the candidate list",',
    '    "direction": "long" | "short",',
    '    "conviction": 0.0-1.0,',
    '    "stop_loss": number,',
    '    "target": number,',
    '    "max_hold_sessions": 1-10,',
    '    "thesis": "why, in plain language",',
    '    "rules_applied": ["R-001"],',
    '    "what_would_falsify_this": "an observation that would prove you wrong"',
    "  }],",
    '  "no_trade_reason": "populated instead of proposals when standing aside"',
    "}",
    "",
    "Propose at most 3 trades. Fewer is better than forced.",
    "You do not set the entry price or the position size — the engine does both.",
    "Only propose symbols present in the candidate list below.",
    "For a long, the target must sit above the stop. For a short, below.",
  ].join("\n");

  const newsBlock = Object.entries(input.news)
    .map(([sym, items]) =>
      items.length === 0
        ? `${sym}: no recent coverage`
        : `${sym}:\n${items.map((n) => `  - ${n.title} (${n.publisher})`).join("\n")}`,
    )
    .join("\n");

  const user = [
    `Market: ${input.market}. Decision date: ${input.asOfDate}.`,
    `Available cash: ${Math.round(input.cash).toLocaleString()} ${input.currency}.`,
    "",
    "## Candidates",
    input.digest,
    "",
    "## Recent headlines",
    newsBlock || "No headlines retrieved.",
    "",
    "## Open positions",
    input.openPositions.length === 0
      ? "None."
      : input.openPositions
          .map(
            (p) =>
              `- ${p.symbol} ${p.direction}, ${p.sessionsHeld} sessions held, ` +
              `${p.unrealisedPct.toFixed(1)}% unrealised`,
          )
          .join("\n"),
    "",
    "## Your last 10 closed trades",
    input.recentOutcomes.length === 0
      ? "No closed trades yet."
      : input.recentOutcomes
          .map(
            (o) =>
              `- ${o.symbol}: ${o.netPct.toFixed(1)}% net, exited on ${o.exitReason}, ` +
              `post-mortem: ${o.category}`,
          )
          .join("\n"),
  ].join("\n");

  return { system, user };
}

export interface PostMortemPromptInput {
  agentMd: string;
  symbol: string;
  direction: string;
  thesis: string;
  falsifier: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  netPct: number;
  sessionsHeld: number;
}

export function buildPostMortemPrompt(i: PostMortemPromptInput): { system: string; user: string } {
  const system = [
    i.agentMd,
    "",
    "## Task",
    "",
    "Write a post-mortem for one closed trade. Respond with JSON only:",
    "",
    "{",
    '  "category": "thesis_wrong" | "thesis_right_timing_wrong" | "rule_violated" | "unmodelled_event" | "correct",',
    '  "expected": "what you expected to happen, in one sentence",',
    '  "actual": "what actually happened, in one sentence",',
    '  "lesson": "what you would do differently, or none if nothing"',
    "}",
    "",
    "Choose the category honestly. They are not interchangeable:",
    "- thesis_wrong: the reasoning was wrong. This should change beliefs.",
    "- thesis_right_timing_wrong: the call was right, the window was not.",
    "- rule_violated: the idea contradicted an existing rule and was taken anyway.",
    "- unmodelled_event: nothing in the available signals could have predicted it.",
    "  This must change nothing — do not draw a lesson from noise.",
    "- correct: it worked, for the stated reason.",
  ].join("\n");

  const user = [
    `${i.symbol} ${i.direction}, held ${i.sessionsHeld} sessions.`,
    `Entry ${i.entryPrice}, exit ${i.exitPrice} on ${i.exitReason}. Net ${i.netPct.toFixed(2)}%.`,
    "",
    `Your thesis was: ${i.thesis}`,
    `You said this would falsify it: ${i.falsifier}`,
  ].join("\n");

  return { system, user };
}

export interface ReflectionPromptInput {
  agentMd: string;
  market: Market;
  reflectionNumber: number;
  postMortems: Array<{ symbol: string; category: string; netPct: number; lesson: string }>;
  ruleStats: Array<{ id: string; title: string; applications: number; wins: number; status: string }>;
}

export function buildReflectionPrompt(i: ReflectionPromptInput): { system: string; user: string } {
  const system = [
    i.agentMd,
    "",
    "## Task",
    "",
    `This is reflection #${i.reflectionNumber} for the ${i.market} book. Propose amendments`,
    "to your own strategy document. Respond with JSON only:",
    "",
    "{",
    '  "summary": "one paragraph on what these trades taught you",',
    '  "add_beliefs": ["..."],',
    '  "remove_beliefs": ["exact text of a belief to drop"],',
    '  "add_rules": [{ "title": "...", "evidence": ["T-1","T-2","T-3","T-4","T-5"] }],',
    '  "retire_rule_ids": ["R-003"],',
    '  "add_failure_modes": ["..."]',
    "}",
    "",
    "Constraints enforced in code, not negotiable:",
    "- A new rule needs at least 5 supporting closed trades in its evidence.",
    "- At most 15 active rules. To add past the cap, retire one in the same amendment.",
    "- Trades categorised unmodelled_event are excluded and are not offered to you.",
    "- You cannot edit the Core Mandate. There is no field for it.",
    "",
    "Proposing nothing is a valid, and often correct, amendment.",
  ].join("\n");

  const user = [
    "## Post-mortems since your last reflection",
    i.postMortems.length === 0
      ? "None."
      : i.postMortems
          .map((p) => `- ${p.symbol} (${p.category}, ${p.netPct.toFixed(1)}%): ${p.lesson}`)
          .join("\n"),
    "",
    "## How your active rules are performing",
    i.ruleStats.length === 0
      ? "You have no rules yet."
      : i.ruleStats
          .map(
            (r) =>
              `- ${r.id} ${r.title}: ${r.wins}/${r.applications} ` +
              `(${r.applications === 0 ? "not yet applied" : `${Math.round((r.wins / r.applications) * 100)}%`}), ${r.status}`,
          )
          .join("\n"),
  ].join("\n");

  return { system, user };
}
