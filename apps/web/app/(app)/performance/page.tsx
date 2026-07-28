import { requireOwner } from "@/lib/auth";
import { BOOKS, getBooks, getClosedTrades, getSnapshots } from "@/lib/queries";
import { buildCurve, computeStats, MIN_TRADES_FOR_WIN_RATE } from "@/lib/stats";
import { EquityChart } from "@/components/EquityChart";
import { money, pct, signedPct } from "@/lib/format";

export const dynamic = "force-dynamic";

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="num text-lg mt-0.5">{value}</div>
      {note && <div className="text-[11px] text-muted mt-0.5">{note}</div>}
    </div>
  );
}

export default async function PerformancePage() {
  await requireOwner();
  const books = await getBooks();

  const sections = await Promise.all(
    BOOKS.map(async (meta) => {
      const book = books.find((b) => b.id === meta.id);
      const starting = book?.startingCapital ?? 999999;
      const all = await getClosedTrades(meta.id, true);
      const real = all.filter((t) => !t.isShadow);
      const shadow = all.filter((t) => t.isShadow);

      return {
        meta,
        starting,
        stats: computeStats(real),
        shadowStats: computeStats(shadow),
        curve: buildCurve(await getSnapshots(meta.id), starting),
      };
    }),
  );

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="serif text-3xl">Performance</h1>
        <p className="text-sm text-muted mt-1">
          Against buy-and-hold, from day one. Ten trades tell you nothing, thirty hint,
          a hundred begin to mean something.
        </p>
      </div>

      {sections.map(({ meta, starting, stats, shadowStats, curve }) => (
        <section key={meta.id} className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between border-b border-border pb-2">
            <h2 className="text-lg">{meta.label}</h2>
            <span className="text-xs text-muted">
              {stats.tradeCount} closed trade{stats.tradeCount === 1 ? "" : "s"}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Tile
              label="net P&L"
              value={money(stats.totalNetPnl, meta.currency)}
              note={`over ${stats.tradeCount} trades`}
            />
            <Tile
              label="return"
              value={signedPct(starting ? (stats.totalNetPnl / starting) * 100 : null)}
              note={`over ${stats.tradeCount} trades`}
            />
            <Tile
              label="win rate"
              value={stats.winRateSuppressed ? "—" : pct(stats.winRate)}
              note={
                stats.winRateSuppressed
                  ? `needs ${MIN_TRADES_FOR_WIN_RATE}, has ${stats.tradeCount}`
                  : "on net P&L"
              }
            />
            <Tile label="costs paid" value={money(stats.totalCosts, meta.currency)} />
            <Tile label="max drawdown" value={pct(stats.maxDrawdownPct)} />
          </div>

          <EquityChart data={curve} label={meta.label} />

          <div className="rounded-lg border border-border bg-surface p-4">
            <h3 className="text-sm mb-2">Real book vs shadow book</h3>
            <p className="text-xs text-muted mb-3">
              The shadow book holds the trades you rejected or let expire, simulated
              identically. If it beats the real book, your filtering is costing you.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Tile
                label="you approved"
                value={money(stats.totalNetPnl, meta.currency)}
                note={`${stats.tradeCount} trades`}
              />
              <Tile
                label="you passed on"
                value={money(shadowStats.totalNetPnl, meta.currency)}
                note={`${shadowStats.tradeCount} trades`}
              />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
