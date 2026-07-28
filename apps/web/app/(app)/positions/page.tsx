import { requireOwner } from "@/lib/auth";
import { BOOKS, getLatestCloses, getOpenPositions, unrealisedPct } from "@/lib/queries";
import { money, shortDate, signedPct } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Where the current price sits between the stop and the target, 0..1. */
function bandPosition(mark: number, stop: number, target: number): number {
  const lo = Math.min(stop, target);
  const hi = Math.max(stop, target);
  if (hi === lo) return 0.5;
  return Math.min(1, Math.max(0, (mark - lo) / (hi - lo)));
}

export default async function PositionsPage() {
  await requireOwner();

  const sections = await Promise.all(
    BOOKS.map(async (book) => {
      const positions = await getOpenPositions(book.id);
      const marks = await getLatestCloses(positions.map((p) => p.symbol));
      return { book, positions, marks };
    }),
  );

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="serif text-3xl">Positions</h1>
        <p className="text-sm text-muted mt-1">
          Marked to the last daily close. This is end-of-day data — not a live quote.
        </p>
      </div>

      {sections.map(({ book, positions, marks }) => (
        <section key={book.id} className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between border-b border-border pb-2">
            <h2 className="text-lg">{book.label}</h2>
            <span className="text-xs text-muted">{positions.length} open</span>
          </div>

          {positions.length === 0 ? (
            <p className="text-sm text-muted">No open positions.</p>
          ) : (
            positions.map((p) => {
              const mark = marks[p.symbol]?.close ?? null;
              const up = unrealisedPct(p, mark);
              const pos = mark ? bandPosition(mark, p.stopLoss, p.target) : 0.5;

              return (
                <article
                  key={p.id}
                  className="rounded-lg border border-border bg-surface p-4 flex flex-col gap-3"
                >
                  <header className="flex items-start justify-between">
                    <div>
                      <h3 className="num">{p.symbol}</h3>
                      <p className="text-xs text-muted">
                        {p.direction} · {p.qty} @ {money(p.entryPrice, book.currency)} ·{" "}
                        {shortDate(p.entryDate)}
                      </p>
                    </div>
                    <div className="text-right">
                      <div
                        className={`num text-lg ${
                          (up ?? 0) >= 0 ? "text-long" : "text-short"
                        }`}
                      >
                        {signedPct(up)}
                      </div>
                      <div className="text-xs text-muted num">
                        {mark ? money(mark, book.currency) : "no mark"}
                      </div>
                    </div>
                  </header>

                  {/* Stop -- price -- target. Makes "about to be stopped out" visible at a glance. */}
                  <div>
                    <div className="relative h-1.5 rounded-full bg-raised">
                      <div
                        className="absolute top-1/2 -translate-y-1/2 size-3 rounded-full bg-accent border-2 border-surface"
                        style={{ left: `calc(${pos * 100}% - 6px)` }}
                      />
                    </div>
                    <div className="flex justify-between mt-1 text-[11px] text-muted num">
                      <span>stop {money(p.stopLoss, book.currency)}</span>
                      <span>target {money(p.target, book.currency)}</span>
                    </div>
                  </div>

                  <p className="text-xs text-muted">
                    Max hold {p.maxHoldSessions} sessions
                    {marks[p.symbol] ? ` · marked ${shortDate(marks[p.symbol]!.date)}` : ""}
                  </p>
                </article>
              );
            })
          )}
        </section>
      ))}
    </div>
  );
}
