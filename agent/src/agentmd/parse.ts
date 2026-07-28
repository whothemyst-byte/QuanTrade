import type { AgentDoc, Rule, RuleStatus } from "./types.js";

const RULE_HEAD = /^###\s+(R-\d{3})\s+[—-]\s+(.+?)\s*$/;
const RETIRED_HEAD = /^###\s+~~(R-\d{3})\s+[—-]\s+(.+?)~~\s*$/;
const BORN = /^-\s+\*\*Born:\*\*\s+(\d{4}-\d{2}-\d{2})/;
const EVIDENCE = /^-\s+\*\*Evidence:\*\*\s+(.+)$/;
const SINCE = /^-\s+\*\*Since born:\*\*\s+(\d+)\s+applications?,\s+(\d+)\s+wins?,\s+([+-]?[\d.]+)%\s+avg/;
const STATUS = /^-\s+\*\*Status:\*\*\s+(active|probation|retired)/;
// Permissive on purpose: the renderer writes the bare reason, but a
// hand-edited file may prefix it with a date. Capture whatever follows.
const RETIRED_META = /^-\s+\*\*Retired:\*\*\s+(.+)$/;

/** Placeholder prose that means "this section is empty", not "here is an item". */
function isPlaceholder(line: string): boolean {
  return /^_?(no|none)\b.*(yet|recorded)/i.test(line.replace(/[_*]/g, "").trim());
}

function splitSections(markdown: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;

  for (const raw of markdown.split(/\r?\n/)) {
    const heading = raw.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1]!.trim();
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)!.push(raw);
  }
  return sections;
}

function bulletList(lines: string[]): string[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0 && !isPlaceholder(l));
}

function parseRules(lines: string[]): Rule[] {
  const rules: Rule[] = [];
  let current: Partial<Rule> | null = null;

  const flush = () => {
    if (current?.id && current.title) {
      rules.push({
        id: current.id,
        title: current.title,
        born: current.born ?? "",
        evidence: current.evidence ?? [],
        applications: current.applications ?? 0,
        wins: current.wins ?? 0,
        avgReturn: current.avgReturn ?? 0,
        status: current.status ?? "active",
        ...(current.retiredReason ? { retiredReason: current.retiredReason } : {}),
      } as Rule);
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    const retiredHead = line.match(RETIRED_HEAD);
    if (retiredHead) {
      flush();
      current = { id: retiredHead[1]!, title: retiredHead[2]!.trim(), status: "retired" };
      continue;
    }

    const head = line.match(RULE_HEAD);
    if (head) {
      flush();
      current = { id: head[1]!, title: head[2]!.trim() };
      continue;
    }

    if (!current) continue;

    const born = line.match(BORN);
    if (born) { current.born = born[1]!; continue; }

    const evidence = line.match(EVIDENCE);
    if (evidence) {
      current.evidence = evidence[1]!.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }

    const since = line.match(SINCE);
    if (since) {
      current.applications = Number(since[1]);
      current.wins = Number(since[2]);
      current.avgReturn = Number(since[3]);
      continue;
    }

    const status = line.match(STATUS);
    if (status) { current.status = status[1] as RuleStatus; continue; }

    const retired = line.match(RETIRED_META);
    if (retired) { current.retiredReason = retired[1]!.trim(); current.status = "retired"; continue; }
  }

  flush();
  return rules;
}

export function parseAgentDoc(markdown: string): AgentDoc {
  const sections = splitSections(markdown);

  const mandate = sections.get("Core Mandate");
  if (!mandate) {
    throw new Error("AGENT.md is missing its Core Mandate section");
  }

  const activeLines = sections.get("Active Rules") ?? [];
  const retiredLines = sections.get("Retired Rules") ?? [];

  return {
    coreMandate: mandate.join("\n").trim(),
    beliefs: bulletList(sections.get("Market Beliefs") ?? []),
    rules: [...parseRules(activeLines), ...parseRules(retiredLines)],
    failureModes: bulletList(sections.get("Known Failure Modes") ?? []),
  };
}
