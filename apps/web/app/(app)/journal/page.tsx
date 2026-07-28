import { requireOwner } from "@/lib/auth";
import { BOOKS, getClosedTrades } from "@/lib/queries";
import { money, shortDate, signedPct } from "@/lib/format";
import { netPct } from "@/lib/stats";

export const dynamic = "force-dynamic";

const CATEGORY_LABEL: Record<string, string> = {
  thesis_wrong: "thesis wrong",
  thesis_right_timing_wrong: "right call, wrong window",
  rule_violated: "broke my own rule",
  unmodelled_event: "unmodelled event",
  correct: "correct",
};

export default async function JournalPage() {
  await requireOwner();

  const sections = await Promise.all(
    BOOKS.map(async (book) => ({
      book,
      trades: await getClosedTrades(book.id, true),
    })),
  );

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="serif text-3xl">Journal</h1>
        <p className="text-sm text-muted mt-1">
          Every closed trade with the thesis it was opened on. Gross, costs, and net are
          shown separately — a trade that made money before costs and lost after is a loss.
        </p>
      </div>

      {sections.map(({ book, trades }) => (
        <section key={book.id} className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between border-b border-border pb-2">
            <h2 className="text-lg">{book.label}</h2>
            <span className="text-xs text-muted">{trades.length} closed</span>
          </div>

          {trades.length === 0 ? (
            <p className="text-sm text-muted">No closed trades yet.</p>
          ) : (
            trades.map((t) => {
              const np = netPct(t);
              const won = (t.netPnl ?? 0) > 0;

              return (
                <details
                  key={t.id}
                  className="rounded-lg border border-border bg-surface p-4"
                >
                  <summary className="cursor-pointer flex items-center justify-between gap-3 list-none">
                    <div className="flex items-center gap-2">
                      <span className="num">{t.symbol}</span>
                      {t.isShadow && (
                        <span className="text-[10px] uppercase tracking-wide rounded-full border border-border px-1.5 py-0.5 text-muted">
                          shadow
                        </span>
                      )}
                      <span className="text-xs text-muted">
                        {t.exitReason} · {t.exitDate ? shortDate(t.exitDate) : "—"}
                      </span>
                    </div>
                    <span className={`num ${won ? "text-long" : "text-short"}`}>
                      {signedPct(np)}
                    </span>
                  </summary>

                  <div className="mt-4 flex flex-col gap-3 text-sm">
                    {t.thesis && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted">
                          Original thesis
                        </div>
                        <p className="mt-0.5">{t.thesis}</p>
                      </div>
                    )}

                    {t.falsifier && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted">
                          What would have proved it wrong
                        </div>
                        <p className="mt-0.5">{t.falsifier}</p>
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-md bg-bg px-2.5 py-1.5">
                        <div className="text-[10px] uppercase text-muted">gross</div>
                        <div className="num text-sm">{money(t.grossPnl, book.currency)}</div>
                      </div>
                      <div className="rounded-md bg-bg px-2.5 py-1.5">
                        <div className="text-[10px] uppercase text-muted">costs</div>
                        <div className="num text-sm">
                          {money(t.entryCosts + t.exitCosts, book.currency)}
                        </div>
                      </div>
                      <div className="rounded-md bg-bg px-2.5 py-1.5">
                        <div className="text-[10px] uppercase text-muted">net</div>
                        <div className="num text-sm">{money(t.netPnl, book.currency)}</div>
                      </div>
                    </div>

                    <p className="text-xs text-muted num">
                      {t.qty} @ {money(t.entryPrice, book.currency)} →{" "}
                      {money(t.exitPrice, book.currency)} · entered {shortDate(t.entryDate)}
                    </p>

                    {t.postMortem ? (
                      <div className="rounded-md border border-border p-3">
                        <span className="text-[10px] uppercase tracking-wide rounded-full bg-raised px-2 py-0.5">
                          {CATEGORY_LABEL[t.postMortem.category] ?? t.postMortem.category}
                        </span>
                        <p className="mt-2">
                          <span className="text-muted">Expected:</span>{" "}
                          {t.postMortem.expected}
                        </p>
                        <p>
                          <span className="text-muted">Actual:</span> {t.postMortem.actual}
                        </p>
                        <p className="mt-1">
                          <span className="text-muted">Lesson:</span> {t.postMortem.lesson}
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted">
                        {t.isShadow
                          ? "Shadow trades are measured, not reflected on."
                          : "No post-mortem recorded."}
                      </p>
                    )}
                  </div>
                </details>
              );
            })
          )}
        </section>
      ))}
    </div>
  );
}
