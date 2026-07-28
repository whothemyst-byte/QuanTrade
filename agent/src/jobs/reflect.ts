import { createHash } from "node:crypto";
import type { Market } from "@quantrade/core";
import type { Db } from "@quantrade/db";
import { parseAgentDoc } from "../agentmd/parse.js";
import { renderAgentDoc } from "../agentmd/render.js";
import { applyAmendment } from "../agentmd/amend.js";
import { AmendmentResponseSchema } from "../agentmd/types.js";
import { askValidated, type LlmProvider } from "../llm/client.js";
import { buildReflectionPrompt } from "../llm/prompts.js";

export interface PostMortemRecord {
  positionId: string;
  symbol: string;
  category: string;
  netPct: number;
  lesson: string;
}

export interface ReflectDeps {
  db: Db;
  providers: LlmProvider[];
  readAgentMd: () => Promise<string>;
  writeAgentMd: (contents: string) => Promise<void>;
  commit: (message: string, body: string) => Promise<string>;
  loadPostMortems: (bookId: string) => Promise<PostMortemRecord[]>;
  reflectionNumber: number;
  today: string;
  notify: (message: string) => Promise<void>;
}

export interface ReflectResult {
  status: "ok" | "refused" | "unchanged" | "failed";
  commitSha?: string;
  rulesAdded: string[];
  rulesRetired: string[];
  reason?: string;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function runReflect(deps: ReflectDeps, market: Market): Promise<ReflectResult> {
  const bookId = market === "NSE" ? "nse-main" : "us-main";
  const runId = await deps.db.startRun(bookId, "reflect");

  try {
    const all = await deps.loadPostMortems(bookId);

    // unmodelled_event trades are excluded entirely. They are noise, and an
    // agent that draws rules from noise will rewrite a sound strategy.
    const usable = all.filter((p) => p.category !== "unmodelled_event");

    const original = await deps.readAgentMd();
    const doc = parseAgentDoc(original);
    const mandateHash = hash(doc.coreMandate);

    const { system, user } = buildReflectionPrompt({
      agentMd: original,
      market,
      reflectionNumber: deps.reflectionNumber,
      postMortems: usable.map((p) => ({
        symbol: p.symbol, category: p.category, netPct: p.netPct, lesson: p.lesson,
      })),
      ruleStats: doc.rules
        .filter((r) => r.status !== "retired")
        .map((r) => ({
          id: r.id, title: r.title,
          applications: r.applications, wins: r.wins, status: r.status,
        })),
    });

    const { response } = await askValidated(deps.providers, AmendmentResponseSchema, system, user);

    const applied = applyAmendment(
      doc,
      {
        addBeliefs: response.add_beliefs ?? [],
        removeBeliefs: response.remove_beliefs ?? [],
        addRules: response.add_rules ?? [],
        retireRuleIds: response.retire_rule_ids ?? [],
        addFailureModes: response.add_failure_modes ?? [],
      },
      { today: deps.today, reflectionNumber: deps.reflectionNumber },
    );

    if (!applied.ok) {
      // Record the refusal so a blocked attempt is visible rather than silent.
      await deps.db.insertReflection({
        run_id: runId, book_id: bookId,
        trades_covered: usable.map((p) => p.positionId),
        commit_sha: null,
        summary: `Amendment refused by guardrails: ${applied.reason}`,
        rules_added: [], rules_retired: [],
      });
      await deps.db.finishRun(runId, "ok");
      return { status: "refused", rulesAdded: [], rulesRetired: [], reason: applied.reason };
    }

    if (hash(applied.doc.coreMandate) !== mandateHash) {
      throw new Error("Core Mandate changed during amendment — refusing to write");
    }

    const rendered = renderAgentDoc(applied.doc);
    // Compare against a re-render of the *unamended* doc, not the raw file.
    // Otherwise a purely cosmetic difference between the file on disk and the
    // renderer's output would read as a change and trigger an empty commit.
    if (rendered === renderAgentDoc(doc)) {
      await deps.db.finishRun(runId, "ok");
      return { status: "unchanged", rulesAdded: [], rulesRetired: [] };
    }

    await deps.writeAgentMd(rendered);

    const sha = await deps.commit(
      `agent: reflection #${deps.reflectionNumber} (${market})`,
      [
        response.summary,
        "",
        `Trades covered: ${usable.map((p) => p.positionId).join(", ") || "none"}`,
        applied.rulesAdded.length ? `Rules added: ${applied.rulesAdded.join(", ")}` : "",
        applied.rulesRetired.length ? `Rules retired: ${applied.rulesRetired.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
    );

    await deps.db.insertReflection({
      run_id: runId, book_id: bookId,
      trades_covered: usable.map((p) => p.positionId),
      commit_sha: sha,
      summary: response.summary,
      rules_added: applied.rulesAdded,
      rules_retired: applied.rulesRetired,
    });

    await deps.db.finishRun(runId, "ok");
    await deps.notify(
      `*${market}* reflection #${deps.reflectionNumber}: ` +
        `+${applied.rulesAdded.length} rules, -${applied.rulesRetired.length}. ${sha.slice(0, 7)}`,
    );

    return {
      status: "ok",
      commitSha: sha,
      rulesAdded: applied.rulesAdded,
      rulesRetired: applied.rulesRetired,
    };
  } catch (err) {
    const message = (err as Error).message;
    await deps.db.finishRun(runId, "failed", { error: message });
    await deps.notify(`*${market}* reflection failed: ${message}`);
    return { status: "failed", rulesAdded: [], rulesRetired: [], reason: message };
  }
}
