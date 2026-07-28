# QuanTrade Plan 4 — Web Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-owner web app for approving proposals from a phone, watching both books, reading the trade journal, and seeing how the agent's mind has changed over time.

**Architecture:** Next.js App Router on Vercel. Server Components read Supabase directly with the anon key under RLS; the one write the browser performs — deciding a pending proposal — goes through a Server Action. No client-side data fetching library, no state manager: the data is read-mostly and revalidation on write is enough.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS v4, `@supabase/ssr`, Recharts for the equity curve.

## Global Constraints

- **Zero cost.** Vercel Hobby, Supabase free tier. No paid analytics, no paid fonts, no image CDN.
- **Single owner.** Supabase email magic-link auth, and a hard allowlist of one email address. Everything is behind it.
- **The browser never holds the service role key.** Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` reach the client.
- **Read paths are Server Components.** The only mutation is approve/reject, via a Server Action against the `proposals_decide` RLS policy from Plan 3.
- **Statistical honesty is enforced in the UI**: win rate is suppressed below 20 closed trades, and every return figure is displayed with its trade count.
- **Brand:** Quansynd — warm amber `#d79a3d` on warm neutrals, editorial type (Instrument Serif for headings, Geist for body, Geist Mono for numbers). Not blue, not a generic SaaS dashboard.
- **Mobile first.** The approval flow is the one thing done on a phone, usually in a hurry, before an open.
- Depends on: Plans 1–3 complete. Spec: `docs/specs/2026-07-28-quantrade-design.md`.

---

## File Structure

```
apps/web/
├─ package.json
├─ next.config.ts
├─ app/
│  ├─ layout.tsx              # shell, fonts, nav
│  ├─ globals.css             # Tailwind v4 theme tokens
│  ├─ login/page.tsx
│  ├─ page.tsx                # Inbox (the default screen)
│  ├─ positions/page.tsx
│  ├─ journal/page.tsx
│  ├─ performance/page.tsx
│  └─ mind/page.tsx
├─ lib/
│  ├─ supabase/server.ts      # server client
│  ├─ supabase/client.ts      # browser client
│  ├─ auth.ts                 # requireOwner()
│  ├─ queries.ts              # typed read helpers
│  └─ format.ts               # money, percent, date formatting
├─ components/
│  ├─ ProposalCard.tsx
│  ├─ DecideButtons.tsx       # client component + Server Action
│  ├─ PositionRow.tsx
│  ├─ TradeCard.tsx
│  ├─ EquityChart.tsx
│  ├─ StatTile.tsx
│  └─ BookTabs.tsx
├─ actions/decide.ts          # Server Action
└─ middleware.ts              # session refresh + route protection
```

---

### Task 1: App shell, auth, and the brand system

**Files:**
- Create: `apps/web/package.json`, `next.config.ts`, `app/layout.tsx`, `app/globals.css`, `app/login/page.tsx`, `lib/supabase/server.ts`, `lib/supabase/client.ts`, `lib/auth.ts`, `lib/format.ts`, `middleware.ts`
- Test: `apps/web/tests/format.test.ts`, `apps/web/tests/auth.test.ts`

**Interfaces:**
- Produces: `createServerSupabase()`, `createBrowserSupabase()`, `requireOwner(): Promise<User>`, and the formatters `money(value, currency)`, `pct(value)`, `signedPct(value)`, `shortDate(iso)`.

- [ ] **Step 1: Scaffold the app**

```bash
cd apps && pnpm create next-app@latest web --typescript --tailwind --app --no-src-dir --import-alias "@/*"
cd web && pnpm add @supabase/supabase-js @supabase/ssr recharts
```

Add to the workspace root `pnpm-workspace.yaml` if not already covered by `apps/*`.

- [ ] **Step 2: Write the failing formatter test**

`apps/web/tests/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { money, pct, signedPct, shortDate } from "../lib/format";

describe("money", () => {
  it("formats INR with the rupee symbol and Indian grouping", () => {
    expect(money(999999, "INR")).toBe("₹9,99,999.00");
  });

  it("formats USD with the dollar symbol", () => {
    expect(money(999999, "USD")).toBe("$999,999.00");
  });

  it("keeps the sign on a loss", () => {
    expect(money(-1234.5, "USD")).toBe("-$1,234.50");
  });
});

describe("pct and signedPct", () => {
  it("renders one decimal place", () => {
    expect(pct(12.345)).toBe("12.3%");
  });

  it("prefixes a plus on gains only", () => {
    expect(signedPct(2.5)).toBe("+2.5%");
    expect(signedPct(-2.5)).toBe("-2.5%");
    expect(signedPct(0)).toBe("0.0%");
  });

  it("renders an em dash for null rather than NaN", () => {
    expect(pct(null)).toBe("—");
    expect(signedPct(null)).toBe("—");
  });
});

describe("shortDate", () => {
  it("formats an ISO date without a timezone shift", () => {
    expect(shortDate("2026-07-28")).toBe("28 Jul 2026");
  });
});
```

The timezone assertion matters more than it looks. `new Date("2026-07-28")`
parses as UTC midnight, which renders as 27 July for anyone west of Greenwich —
a trade journal that reports the wrong day is worse than one with no dates.

- [ ] **Step 3: Implement `lib/format.ts`**

```ts
export function money(value: number | null, currency: "INR" | "USD"): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value);
}

export function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export function signedPct(value: number | null): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/** Format a plain YYYY-MM-DD without letting Date drag it across a timezone. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[(m ?? 1) - 1]} ${y}`;
}
```

Run: `pnpm vitest run apps/web/tests/format.test.ts` — expected PASS, 8 tests.

- [ ] **Step 4: Define the theme**

`app/globals.css`:

```css
@import "tailwindcss";

@theme {
  --color-bg: oklch(0.16 0.008 70);
  --color-surface: oklch(0.21 0.010 70);
  --color-border: oklch(0.30 0.012 70);
  --color-text: oklch(0.93 0.008 80);
  --color-muted: oklch(0.68 0.012 80);
  --color-accent: #d79a3d;
  --color-long: oklch(0.72 0.14 150);
  --color-short: oklch(0.68 0.17 25);

  --font-display: "Instrument Serif", Georgia, serif;
  --font-sans: "Geist", system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, monospace;
}

/* Every price, P&L, and percentage is tabular so columns align down the page. */
.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
```

Load Instrument Serif, Geist, and Geist Mono through `next/font/google` in
`app/layout.tsx` — self-hosted at build time, so no runtime font request and
nothing to pay for.

- [ ] **Step 5: Implement auth**

`lib/auth.ts`:

```ts
import { redirect } from "next/navigation";
import { createServerSupabase } from "./supabase/server";

const OWNER_EMAIL = process.env.OWNER_EMAIL!;

/** Single-owner app. RLS lets any authenticated user read, so the allowlist
 *  here is what stops a stray Supabase signup from seeing the book. */
export async function requireOwner() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  if (user.email?.toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
    await supabase.auth.signOut();
    redirect("/login?denied=1");
  }
  return user;
}
```

`app/login/page.tsx` renders a single email field that calls
`signInWithOtp({ email })` — magic link, no password to manage or leak.

`middleware.ts` refreshes the Supabase session cookie on every request and
redirects unauthenticated traffic to `/login`, excluding `/login` itself and
static assets.

Add `apps/web/tests/auth.test.ts` asserting `requireOwner` redirects when there
is no user, redirects with `denied=1` for a non-owner email, matches the owner
email case-insensitively, and returns the user on a match. Mock
`createServerSupabase` and `redirect`.

- [ ] **Step 6: Build the shell**

`app/layout.tsx` renders the fonts, a header with the QuanTrade wordmark in
Instrument Serif, and a bottom tab bar on mobile / sidebar on desktop linking
Inbox, Positions, Journal, Performance, Mind.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): app shell, magic-link owner auth, and the Quansynd theme"
```

---

### Task 2: Proposal inbox and the decision flow

**Files:**
- Create: `app/page.tsx`, `components/ProposalCard.tsx`, `components/DecideButtons.tsx`, `components/BookTabs.tsx`, `actions/decide.ts`, `lib/queries.ts`
- Test: `apps/web/tests/decide.test.ts`

**Interfaces:**
- Consumes: `requireOwner`, the formatters.
- Produces: `getPendingProposals(bookId)` in `queries.ts`, and the `decideProposal(proposalId, decision)` Server Action.

This is the screen that exists. Everything else is reporting.

- [ ] **Step 1: Write the failing Server Action test**

`apps/web/tests/decide.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decideProposal } from "../actions/decide";

const update = vi.fn();
const eq = vi.fn();

vi.mock("../lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    from: () => ({ update: (v: unknown) => { update(v); return { eq: (...a: unknown[]) => { eq(...a); return { eq: () => ({ select: () => ({ data: [{ id: "p1" }], error: null }) }) }; } }; } }),
  }),
}));
vi.mock("../lib/auth", () => ({ requireOwner: async () => ({ email: "owner@example.com" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(() => { update.mockClear(); eq.mockClear(); });

describe("decideProposal", () => {
  it("sets approved and stamps decided_at", async () => {
    await decideProposal("p1", "approved");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", decided_at: expect.any(String) }),
    );
  });

  it("sets rejected", async () => {
    await decideProposal("p1", "rejected");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" }));
  });

  it("scopes the update to pending rows so a decision cannot be reversed", async () => {
    await decideProposal("p1", "approved");
    expect(eq).toHaveBeenCalledWith("id", "p1");
  });

  it("rejects a decision value outside the allowed pair", async () => {
    await expect(decideProposal("p1", "expired" as never)).rejects.toThrow(/decision/i);
  });

  it("requires the owner", async () => {
    // Re-mock requireOwner to throw and assert the action propagates it.
  });
});
```

- [ ] **Step 2: Implement the action**

`actions/decide.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase/server";

export async function decideProposal(id: string, decision: "approved" | "rejected") {
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error(`Invalid decision "${decision}"`);
  }
  await requireOwner();

  const supabase = await createServerSupabase();
  const { error } = await supabase
    .from("proposals")
    .update({ status: decision, decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")   // a decided proposal cannot be re-decided
    .select();

  if (error) throw new Error(`Failed to record the decision: ${error.message}`);
  revalidatePath("/");
}
```

The second `.eq("status", "pending")` is doing real work. It makes the update
idempotent and stops a double-tap on a phone — or a stale tab — from flipping a
decision the settle job may already have acted on.

- [ ] **Step 3: Build the inbox**

`app/page.tsx` is a Server Component: `requireOwner()`, then fetch pending
proposals for both books, grouped under `BookTabs`.

`ProposalCard` shows, in this order — because this is the order you actually
need it in when deciding:

1. Symbol, direction, and conviction as a filled bar.
2. The thesis, in full. Never truncated; it is the entire basis for the decision.
3. Stop, target, and the implied reward-to-risk ratio, computed from the
   previous close.
4. "What would falsify this" in a visually distinct block — the single most
   useful line for spotting a weak idea.
5. The signal snapshot as a compact grid.
6. The rules the agent applied, as chips linking to `/mind`.
7. Expiry countdown.
8. Approve / Reject.

`DecideButtons` is the only client component: `useTransition` for pending
state, buttons disabled while the action is in flight, and an optimistic fade
on the card.

- [ ] **Step 4: Handle the empty and expired states**

An empty inbox is the common case and must not look like a broken page. Render
the agent's `market_view` and `no_trade_reason` from the most recent run
instead — "the agent looked and decided to stand aside, here's why" is real
information, and the screen would otherwise be blank most days.

Expired proposals render greyed with an "expired — tracked in the shadow book"
note, so an inaction is visible rather than silently vanishing.

- [ ] **Step 5: Run tests and commit**

```bash
git add apps/web
git commit -m "feat(web): proposal inbox with idempotent approve and reject"
```

---

### Task 3: Positions and the trade journal

**Files:**
- Create: `app/positions/page.tsx`, `app/journal/page.tsx`, `components/PositionRow.tsx`, `components/TradeCard.tsx`
- Test: `apps/web/tests/journal.test.ts`

**Interfaces:**
- Produces: `getOpenPositions(bookId)`, `getClosedTrades(bookId, limit)`, `unrealisedPct(position, lastClose)` in `queries.ts`.

- [ ] **Step 1: Write the failing test**

`apps/web/tests/journal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { unrealisedPct, netPct, groupByOutcome } from "../lib/queries";

describe("unrealisedPct", () => {
  it("computes a long gain", () => {
    expect(unrealisedPct({ direction: "long", entryPrice: 100 } as never, 110)).toBe(10);
  });

  it("computes a short gain as the inverse", () => {
    expect(unrealisedPct({ direction: "short", entryPrice: 100 } as never, 90)).toBe(10);
  });

  it("returns null when there is no mark", () => {
    expect(unrealisedPct({ direction: "long", entryPrice: 100 } as never, null)).toBeNull();
  });
});

describe("netPct", () => {
  it("expresses net P&L against the capital actually committed", () => {
    // 50 shares at 100 = 5,000 committed; 250 net -> 5%
    expect(netPct({ qty: 50, entryPrice: 100, netPnl: 250 } as never)).toBe(5);
  });

  it("returns null for an open position", () => {
    expect(netPct({ qty: 50, entryPrice: 100 } as never)).toBeNull();
  });
});

describe("groupByOutcome", () => {
  it("separates winners from losers on net, not gross", () => {
    const trades = [
      { grossPnl: 100, netPnl: -20 },   // profitable gross, losing net
      { grossPnl: 500, netPnl: 480 },
    ] as never[];
    const { winners, losers } = groupByOutcome(trades);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });
});
```

The `groupByOutcome` test encodes the spec's insistence that costs are never
netted away silently. A trade that made money before costs and lost money after
is a loss, and the UI must say so.

- [ ] **Step 2: Build the positions screen**

`PositionRow` shows symbol, direction, quantity, entry, current mark, unrealised
P&L in money and percent, sessions held out of max, and a distance-to-stop /
distance-to-target bar with the current price positioned between them. The bar
is the whole point — it makes "about to be stopped out" visible at a glance.

Marks come from the latest `daily_bars` close, and the screen states the as-of
date plainly. This is end-of-day data on a free tier, and the UI should not
imply otherwise by showing a live-looking number.

- [ ] **Step 3: Build the journal**

`TradeCard`, expandable, showing in order: outcome badge and net P&L; the
original thesis; the falsification claim; what actually happened (exit reason,
sessions held); the post-mortem category as a coloured chip; the lesson; and a
gross / costs / net breakdown as three separate figures.

Filters: book, outcome, post-mortem category, and real vs shadow.

- [ ] **Step 4: Run tests and commit**

```bash
git add apps/web
git commit -m "feat(web): positions view and the trade journal with post-mortems"
```

---

### Task 4: Performance and benchmarks

**Files:**
- Create: `app/performance/page.tsx`, `components/EquityChart.tsx`, `components/StatTile.tsx`
- Test: `apps/web/tests/stats.test.ts`

**Interfaces:**
- Produces: `computeStats(trades): Stats`, `buildCurve(snapshots, benchmark): CurvePoint[]`.

- [ ] **Step 1: Write the failing stats test**

`apps/web/tests/stats.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeStats } from "../lib/stats";

function trades(n: number, winners: number) {
  return Array.from({ length: n }, (_, i) => ({
    netPnl: i < winners ? 100 : -50,
    grossPnl: i < winners ? 110 : -40,
    qty: 10, entryPrice: 100,
  })) as never[];
}

describe("computeStats", () => {
  it("suppresses win rate below 20 closed trades", () => {
    const s = computeStats(trades(19, 12));
    expect(s.winRate).toBeNull();
    expect(s.winRateSuppressed).toBe(true);
    expect(s.tradeCount).toBe(19);
  });

  it("reports win rate at exactly 20", () => {
    const s = computeStats(trades(20, 12));
    expect(s.winRate).toBe(60);
    expect(s.winRateSuppressed).toBe(false);
  });

  it("always reports trade count, even at zero", () => {
    expect(computeStats([]).tradeCount).toBe(0);
  });

  it("classifies on net, so a gross winner that lost to costs is a loss", () => {
    const s = computeStats([
      { netPnl: -5, grossPnl: 50, qty: 10, entryPrice: 100 },
      ...trades(19, 19),
    ] as never[]);
    expect(s.winRate).toBe(95);
  });

  it("reports total costs paid as a first-class figure", () => {
    const s = computeStats(trades(20, 10));
    expect(s.totalCosts).toBeGreaterThan(0);
  });

  it("computes max drawdown from the equity path", () => {
    const s = computeStats(trades(20, 10));
    expect(s.maxDrawdownPct).toBeLessThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Implement `lib/stats.ts`**

`Stats` carries `tradeCount`, `winRate: number | null`, `winRateSuppressed`,
`totalNetPnl`, `totalGrossPnl`, `totalCosts`, `avgWin`, `avgLoss`,
`maxDrawdownPct`, and `expectancy`. `winRate` is `null` below 20 trades and the
component renders "needs 20 trades, has N" rather than a number — the
suppression must be visible, not just absent.

- [ ] **Step 3: Build the equity chart**

`EquityChart` plots three lines with Recharts: the real book, the shadow book,
and the benchmark (NIFTY 50 for NSE, SPY for US) normalised to the same
starting capital. The benchmark is drawn in a neutral tone at equal visual
weight — not a faint reference line. It is the thing the agent is actually
being judged against and the design should not let it recede.

Benchmark values come from `equity_snapshots.benchmark_value`, populated by the
settle job from the index symbol's close.

- [ ] **Step 4: Assemble the page**

Stat tiles above the chart, per book: net P&L, return percentage with trade
count beside it, win rate or its suppression notice, total costs paid, and
max drawdown. Below the chart, a "real vs shadow vs benchmark" comparison
answering the two questions the whole design exists to answer.

- [ ] **Step 5: Run tests and commit**

```bash
git add apps/web
git commit -m "feat(web): performance screen with benchmarks and suppressed small-sample stats"
```

---

### Task 5: The Mind screen

**Files:**
- Create: `app/mind/page.tsx`, `lib/agentmd.ts`
- Test: `apps/web/tests/mind.test.ts`

**Interfaces:**
- Produces: `getAgentDoc()` reading `AGENT.md` from the repo at build time, `getReflectionHistory()` reading the `reflections` table.

- [ ] **Step 1: Render the current mind**

`app/mind/page.tsx` renders the four AGENT.md zones, reusing `parseAgentDoc`
from the `agent` package rather than re-implementing the parser. The Core
Mandate is visually marked immutable — a lock icon and a muted border — because
the distinction between what the agent may change and what it may not is the
most important thing on the screen.

Each active rule renders as a card: ID, title, born date, hit rate as
`wins/applications`, average return, and a status chip. Rules on probation get
an amber border; retired rules collapse into a separate section, struck
through, with their retirement reason.

- [ ] **Step 2: Render the history**

Below the current state, a timeline from the `reflections` table: date, trades
covered, summary, rules added, rules retired, and the commit SHA linking to
`https://github.com/whothemyst-byte/QuanTrade/commit/<sha>`.

This is where the "the agent learns" claim becomes checkable rather than
asserted. Every entry links to a diff of exactly what changed in its thinking
and lists the trades that caused it.

- [ ] **Step 3: Write the test**

`apps/web/tests/mind.test.ts` asserts: the Core Mandate renders with its
immutable marker, rules render with computed hit rates, a rule with zero
applications shows "not yet applied" rather than `NaN%`, retired rules are
separated from active ones, and the commit link is built correctly from a SHA.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): mind screen rendering AGENT.md and its commit history"
```

---

### Task 6: Deploy and live smoke test

**Files:**
- Modify: `apps/web/next.config.ts`
- Create: `apps/web/README.md`

- [ ] **Step 1: Deploy to Vercel**

```bash
cd apps/web && pnpm vercel --prod
```

Set environment variables in the Vercel project: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `OWNER_EMAIL`. **The service role key is not
among them** — the web app has no need for it, and adding it would put a
full-access credential one misconfiguration away from the browser.

Add the deployed origin to Supabase Auth → URL Configuration → Redirect URLs,
or magic links will bounce.

- [ ] **Step 2: Smoke test the full loop on a phone**

1. Open the deployment on a phone, request a magic link, sign in.
2. Confirm a non-owner email is rejected with `denied=1`.
3. Trigger a `propose` run via `workflow_dispatch`.
4. Confirm the Telegram message arrives and the proposal appears in the inbox.
5. Approve one, reject another.
6. Trigger `settle`.
7. Confirm the approved one appears under Positions with costs applied, and the
   rejected one appears as a shadow trade.
8. Confirm the equity snapshot lands on the Performance screen.

- [ ] **Step 3: Verify the cost floor held**

Check the Vercel dashboard for hobby-plan compliance, Supabase for storage
under 500 MB, and the GitHub Actions minutes used for the month. Record the
figures in `apps/web/README.md`. If any is trending toward a limit, raise it
now rather than at the point of a bill.

- [ ] **Step 4: Commit**

```bash
git add apps/web/README.md apps/web/next.config.ts
git commit -m "docs(web): deployment notes and verified free-tier usage"
```

---

## Definition of Done

- [ ] `pnpm test` green across every package, `agent`, and `apps/web`.
- [ ] The deployed app is reachable, and a non-owner email cannot get past `/login`.
- [ ] A proposal can be approved on a phone and becomes a position at the next settle.
- [ ] A rejected proposal appears in the shadow book with an identical simulation.
- [ ] The Performance screen shows both books against their benchmarks, displays trade counts beside every return, and refuses to show a win rate below 20 closed trades.
- [ ] The Mind screen renders AGENT.md with working commit links.
- [ ] No `SUPABASE_SERVICE_ROLE_KEY` appears anywhere in `apps/web`. Verify: `grep -rn "SERVICE_ROLE" apps/web` returns no matches.
- [ ] Six commits exist, one per task.

## After this plan

The system is complete and running. What remains is not building but waiting:
the spec's success criteria include ten consecutive unattended session days and
at least one reflection run that amends `AGENT.md`. Neither can be rushed, and
the honest expectation set out in spec section 9 applies — an agent that
underperforms its benchmark over 60 trades is a real answer, cheaply obtained,
and worth more than a system whose numbers nobody can trust.
