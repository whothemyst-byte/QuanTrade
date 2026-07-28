import type { AgentDoc, Rule } from "./types.js";

function renderActiveRule(r: Rule): string {
  return [
    `### ${r.id} — ${r.title}`,
    `- **Born:** ${r.born}`,
    `- **Evidence:** ${r.evidence.join(", ")}`,
    `- **Since born:** ${r.applications} applications, ${r.wins} wins, ` +
      `${r.avgReturn >= 0 ? "+" : ""}${r.avgReturn}% avg`,
    `- **Status:** ${r.status}`,
  ].join("\n");
}

function renderRetiredRule(r: Rule): string {
  return [
    `### ~~${r.id} — ${r.title}~~`,
    `- **Born:** ${r.born}`,
    `- **Evidence:** ${r.evidence.join(", ")}`,
    `- **Since born:** ${r.applications} applications, ${r.wins} wins, ` +
      `${r.avgReturn >= 0 ? "+" : ""}${r.avgReturn}% avg`,
    `- **Retired:** ${r.retiredReason ?? "no reason recorded"}`,
  ].join("\n");
}

function list(items: string[], emptyText: string): string {
  return items.length === 0 ? emptyText : items.map((i) => `- ${i}`).join("\n");
}

export function renderAgentDoc(doc: AgentDoc): string {
  const active = doc.rules.filter((r) => r.status !== "retired");
  const retired = doc.rules.filter((r) => r.status === "retired");

  return [
    "# QuanTrade Agent",
    "",
    "## Core Mandate",
    "",
    doc.coreMandate,
    "",
    "## Market Beliefs",
    "",
    list(doc.beliefs, "_No beliefs recorded yet._"),
    "",
    "## Active Rules",
    "",
    "<!-- Maximum 15. A new rule needs at least 5 supporting closed trades. -->",
    "",
    active.length === 0 ? "_No rules yet._" : active.map(renderActiveRule).join("\n\n"),
    "",
    "## Known Failure Modes",
    "",
    list(doc.failureModes, "_None recorded yet._"),
    "",
    "## Retired Rules",
    "",
    retired.length === 0 ? "_None yet._" : retired.map(renderRetiredRule).join("\n\n"),
    "",
  ].join("\n");
}
