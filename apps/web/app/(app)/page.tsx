import { requireOwner } from "@/lib/auth";
import { BOOKS, getLatestMarketView, getPendingProposals } from "@/lib/queries";
import { DecideButtons } from "@/components/DecideButtons";
import { countdown, money, pct, rewardToRisk, shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

function Signal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-bg px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="num text-sm">{value}</div>
    </div>
  );
}

export default async function InboxPage() {
  await requireOwner();

  const sections = await Promise.all(
    BOOKS.map(async (book) => ({
      book,
      proposals: await getPendingProposals(book.id),
      lastRun: await getLatestMarketView(book.id),
    })),
  );

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="serif text-3xl">Inbox</h1>
        <p className="text-sm text-muted mt-1">
          Approve or reject. Rejected ideas are still simulated, so you can see whether
          your filtering helps.
        </p>
      </div>

      {sections.map(({ book, proposals, lastRun }) => (
        <section key={book.id} className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between border-b border-border pb-2">
            <h2 className="text-lg">{book.label}</h2>
            <span className="text-xs text-muted">
              {proposals.length} pending
              {lastRun ? ` · last run ${shortDate(lastRun.at)}` : ""}
            </span>
          </div>

          {proposals.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-5">
              <p className="text-sm">
                Nothing waiting on you.
                {lastRun?.status === "failed"
                  ? " The last run failed — see below."
                  : " The agent looked and stood aside."}
              </p>
              {lastRun?.error && (
                <p className="mt-2 text-xs text-short num">{lastRun.error}</p>
              )}
            </div>
          ) : (
            proposals.map((p) => {
              const reference = Number(
                (p.signals as { close?: number } | null)?.close ?? p.stopLoss,
              );
              const rr = rewardToRisk(reference, p.stopLoss, p.target);
              const s = p.signals as Record<string, number | string | null>;

              return (
                <article
                  key={p.id}
                  className="rounded-lg border border-border bg-surface p-5 flex flex-col gap-4"
                >
                  <header className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg num">{p.symbol}</h3>
                      <span
                        className={`text-xs uppercase tracking-wide ${
                          p.direction === "long" ? "text-long" : "text-short"
                        }`}
                      >
                        {p.direction}
                      </span>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted">conviction</div>
                      <div className="num text-sm">{pct(p.conviction * 100)}</div>
                    </div>
                  </header>

                  {/* The thesis is the entire basis for the decision — never truncated. */}
                  <p className="text-sm leading-relaxed">{p.thesis}</p>

                  <div className="rounded-md border border-accent/40 bg-accent/5 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-accent">
                      What would prove this wrong
                    </div>
                    <p className="text-sm mt-0.5">{p.falsifier}</p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Signal label="stop" value={money(p.stopLoss, book.currency)} />
                    <Signal label="target" value={money(p.target, book.currency)} />
                    <Signal label="reward:risk" value={rr === null ? "—" : `${rr}:1`} />
                    <Signal label="max hold" value={`${p.maxHoldSessions} sessions`} />
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Signal label="RSI" value={s.rsi14 === null ? "n/a" : String(s.rsi14 ?? "n/a")} />
                    <Signal label="trend" value={String(s.trend ?? "n/a")} />
                    <Signal label="vol vs 20d" value={s.volRatio20 ? `${s.volRatio20}x` : "n/a"} />
                    <Signal label="5-day" value={s.ret5 === null ? "n/a" : `${s.ret5 ?? "n/a"}%`} />
                  </div>

                  {p.rulesApplied.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {p.rulesApplied.map((r) => (
                        <a
                          key={r}
                          href="/mind"
                          className="num text-[11px] rounded-full border border-border px-2 py-0.5 text-muted"
                        >
                          {r}
                        </a>
                      ))}
                    </div>
                  )}

                  <footer className="flex flex-col gap-2">
                    <span className="text-xs text-muted">{countdown(p.expiresAt)}</span>
                    <DecideButtons proposalId={p.id} />
                  </footer>
                </article>
              );
            })
          )}
        </section>
      ))}
    </div>
  );
}
