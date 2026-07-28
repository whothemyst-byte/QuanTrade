import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireOwner } from "@/lib/auth";
import { bookMeta, getReflections } from "@/lib/queries";
import { shortDate } from "@/lib/format";
import { parseAgentDoc } from "@/lib/agentmd";

export const dynamic = "force-dynamic";

const REPO = "https://github.com/whothemyst-byte/QuanTrade";

async function loadAgentDoc() {
  // Walk up from apps/web to the repo root where AGENT.md lives.
  const path = join(process.cwd(), "..", "..", "AGENT.md");
  try {
    return parseAgentDoc(await readFile(path, "utf8"));
  } catch {
    try {
      return parseAgentDoc(await readFile(join(process.cwd(), "AGENT.md"), "utf8"));
    } catch {
      return null;
    }
  }
}

function hitRate(applications: number, wins: number): string {
  if (applications === 0) return "not yet applied";
  return `${wins}/${applications} · ${Math.round((wins / applications) * 100)}%`;
}

export default async function MindPage() {
  await requireOwner();
  const doc = await loadAgentDoc();
  const reflections = await getReflections();

  const active = doc?.rules.filter((r) => r.status !== "retired") ?? [];
  const retired = doc?.rules.filter((r) => r.status === "retired") ?? [];

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="serif text-3xl">Mind</h1>
        <p className="text-sm text-muted mt-1">
          What the agent believes, and every change it has made to those beliefs.
        </p>
      </div>

      {!doc ? (
        <p className="text-sm text-muted">AGENT.md could not be read.</p>
      ) : (
        <>
          <section>
            <div className="flex items-center gap-2 border-b border-border pb-2 mb-3">
              <h2 className="text-lg">Core Mandate</h2>
              <span className="text-[10px] uppercase tracking-wide rounded-full border border-accent text-accent px-2 py-0.5">
                locked · agent cannot edit
              </span>
            </div>
            <pre className="rounded-lg border-2 border-accent/30 bg-surface p-4 text-xs whitespace-pre-wrap leading-relaxed text-muted">
              {doc.coreMandate}
            </pre>
          </section>

          <section>
            <h2 className="text-lg border-b border-border pb-2 mb-3">Market Beliefs</h2>
            {doc.beliefs.length === 0 ? (
              <p className="text-sm text-muted">
                None yet. Beliefs appear after the first reflection.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {doc.beliefs.map((b) => (
                  <li key={b} className="rounded-md bg-surface px-3 py-2 text-sm">
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="flex items-baseline justify-between border-b border-border pb-2 mb-3">
              <h2 className="text-lg">Active Rules</h2>
              <span className="text-xs text-muted">{active.length} of 15</span>
            </div>
            {active.length === 0 ? (
              <p className="text-sm text-muted">
                No rules yet. A rule needs five supporting trades to be born.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {active.map((r) => (
                  <article
                    key={r.id}
                    className={`rounded-lg border bg-surface p-4 ${
                      r.status === "probation"
                        ? "border-accent"
                        : "border-border"
                    }`}
                  >
                    <header className="flex items-start justify-between gap-3">
                      <div>
                        <span className="num text-xs text-muted">{r.id}</span>
                        <h3 className="text-sm">{r.title}</h3>
                      </div>
                      <span className="text-[10px] uppercase tracking-wide rounded-full bg-raised px-2 py-0.5">
                        {r.status}
                      </span>
                    </header>
                    <p className="mt-2 text-xs text-muted num">
                      born {r.born || "—"} · {hitRate(r.applications, r.wins)} ·{" "}
                      {r.avgReturn >= 0 ? "+" : ""}
                      {r.avgReturn}% avg
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="text-lg border-b border-border pb-2 mb-3">
              Known Failure Modes
            </h2>
            {doc.failureModes.length === 0 ? (
              <p className="text-sm text-muted">None recorded yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {doc.failureModes.map((f) => (
                  <li key={f} className="rounded-md bg-surface px-3 py-2 text-sm">
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {retired.length > 0 && (
            <section>
              <h2 className="text-lg border-b border-border pb-2 mb-3">Retired Rules</h2>
              <div className="flex flex-col gap-2">
                {retired.map((r) => (
                  <article
                    key={r.id}
                    className="rounded-lg border border-border bg-surface p-3 opacity-60"
                  >
                    <h3 className="text-sm line-through">
                      <span className="num text-xs mr-2">{r.id}</span>
                      {r.title}
                    </h3>
                    <p className="mt-1 text-xs text-muted">
                      {r.retiredReason ?? "no reason recorded"}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <section>
        <h2 className="text-lg border-b border-border pb-2 mb-3">
          How its thinking changed
        </h2>
        {reflections.length === 0 ? (
          <p className="text-sm text-muted">
            No reflections yet. One runs every 10 closed trades per book.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {reflections.map((r) => (
              <li key={r.id} className="rounded-lg border border-border bg-surface p-4">
                <header className="flex items-baseline justify-between gap-3">
                  <span className="text-sm">{bookMeta(r.bookId).label}</span>
                  <span className="text-xs text-muted">{shortDate(r.createdAt)}</span>
                </header>
                <p className="mt-2 text-sm">{r.summary}</p>
                <p className="mt-2 text-xs text-muted num">
                  {r.tradesCovered.length} trades ·{" "}
                  {r.rulesAdded.length ? `added ${r.rulesAdded.join(", ")}` : "no rules added"} ·{" "}
                  {r.rulesRetired.length ? `retired ${r.rulesRetired.join(", ")}` : "none retired"}
                </p>
                {r.commitSha && (
                  <a
                    href={`${REPO}/commit/${r.commitSha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs text-accent num"
                  >
                    {r.commitSha.slice(0, 7)} →
                  </a>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
