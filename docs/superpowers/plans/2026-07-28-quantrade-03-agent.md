# QuanTrade Plan 3 — Agent, Persistence, and Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the system in Supabase, give the agent a strategy document it can amend under enforced guardrails, wire the LLM, and run the whole thing on a schedule for free.

**Architecture:** A `@quantrade/db` package wraps Supabase. An `agent/` workspace holds the three runnable jobs — propose, settle, reflect — plus the `AGENT.md` reader/writer and the LLM client. GitHub Actions invokes the jobs on cron. The guardrails on AGENT.md live in code, not in the prompt: a model that is asked nicely not to exceed 15 rules will eventually exceed 15 rules.

**Tech Stack:** TypeScript, `@supabase/supabase-js`, Zod, Vitest, GitHub Actions, Groq + Gemini free tiers, Telegram Bot API.

## Global Constraints

- **Zero cost.** Supabase free, GitHub Actions free minutes, Groq and Gemini free tiers, Telegram free. Nothing here may require a paid plan.
- **Secrets live in GitHub Actions secrets only.** `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Never committed, never shipped to the browser.
- **Supabase project:** `kdjghlybcecvzowxzsqz`, managed through the `quantrade` MCP. Every migration is also committed as SQL under `supabase/migrations/`.
- **No test calls a real LLM or a real database.** Both are injected dependencies with fakes in tests.
- **A failed run skips the day.** It never degrades to stale data, a guessed price, or an unvalidated model response.
- **The Core Mandate section of AGENT.md is immutable to the agent** and this is verified by hash after every write.
- Depends on: Plans 1 and 2 complete. Spec: `docs/specs/2026-07-28-quantrade-design.md`.

---

## File Structure

```
supabase/migrations/0001_initial_schema.sql
packages/db/
├─ src/client.ts          # createClient wrapper
├─ src/books.ts           # book + equity snapshot queries
├─ src/proposals.ts
├─ src/positions.ts
├─ src/bars.ts            # daily_bars cache
├─ src/reflections.ts
└─ src/index.ts
agent/
├─ src/agentmd/parse.ts   # AGENT.md -> AgentDoc
├─ src/agentmd/render.ts  # AgentDoc -> AGENT.md
├─ src/agentmd/amend.ts   # guardrail enforcement
├─ src/llm/client.ts      # Groq primary, Gemini failover
├─ src/llm/prompts.ts
├─ src/jobs/propose.ts
├─ src/jobs/settle.ts
├─ src/jobs/reflect.ts
├─ src/notify/telegram.ts
└─ src/cli.ts             # entry point: node cli.js <job> <market>
AGENT.md
.github/workflows/trading.yml
```

---

### Task 1: Database schema

**Files:**
- Create: `supabase/migrations/0001_initial_schema.sql`
- Verify: applied to project `kdjghlybcecvzowxzsqz` via the `quantrade` MCP

**Interfaces:**
- Consumes: nothing.
- Produces: the tables every later task reads and writes.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0001_initial_schema.sql`:

```sql
-- QuanTrade initial schema.
-- Money is numeric(18,4): never float, because a float ledger drifts.

create table books (
  id               text primary key,
  market           text not null check (market in ('NSE','US')),
  currency         text not null check (currency in ('INR','USD')),
  starting_capital numeric(18,4) not null,
  cash             numeric(18,4) not null,
  created_at       timestamptz not null default now()
);

create table instruments (
  symbol text primary key,
  market text not null check (market in ('NSE','US')),
  name   text not null,
  sector text not null
);

create table daily_bars (
  symbol text not null references instruments(symbol) on delete cascade,
  date   date not null,
  open   numeric(18,4) not null,
  high   numeric(18,4) not null,
  low    numeric(18,4) not null,
  close  numeric(18,4) not null,
  volume bigint not null,
  primary key (symbol, date),
  constraint bar_coherent check (
    high >= greatest(open, close) and
    low  <= least(open, close) and
    high >= low and volume >= 0
  )
);

create table runs (
  id         uuid primary key default gen_random_uuid(),
  book_id    text references books(id),
  type       text not null check (type in ('propose','settle','reflect')),
  status     text not null check (status in ('running','ok','failed')),
  model      text,
  tokens     integer,
  error      text,
  started_at timestamptz not null default now(),
  ended_at   timestamptz
);

create table proposals (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references runs(id) on delete cascade,
  book_id               text not null references books(id),
  symbol                text not null references instruments(symbol),
  direction             text not null check (direction in ('long','short')),
  conviction            numeric(4,3) not null check (conviction between 0 and 1),
  stop_loss             numeric(18,4) not null,
  target                numeric(18,4) not null,
  max_hold_sessions     smallint not null check (max_hold_sessions between 1 and 10),
  thesis                text not null,
  rules_applied         text[] not null default '{}',
  falsifier             text not null,
  signals_snapshot      jsonb not null,
  status                text not null default 'pending'
                        check (status in ('pending','approved','rejected','expired','engine_rejected')),
  engine_reject_reason  text,
  expires_at            timestamptz not null,
  decided_at            timestamptz,
  created_at            timestamptz not null default now()
);

create table positions (
  id                uuid primary key default gen_random_uuid(),
  proposal_id       uuid not null references proposals(id) on delete cascade,
  book_id           text not null references books(id),
  symbol            text not null references instruments(symbol),
  sector            text not null,
  direction         text not null check (direction in ('long','short')),
  qty               integer not null check (qty > 0),
  entry_price       numeric(18,4) not null,
  entry_date        date not null,
  stop_loss         numeric(18,4) not null,
  target            numeric(18,4) not null,
  max_hold_sessions smallint not null,
  entry_costs       numeric(18,4) not null default 0,
  status            text not null default 'open' check (status in ('open','closed')),
  is_shadow         boolean not null default false,
  exit_price        numeric(18,4),
  exit_date         date,
  exit_reason       text check (exit_reason in ('stop','target','max_hold','forced')),
  exit_costs        numeric(18,4),
  gross_pnl         numeric(18,4),
  net_pnl           numeric(18,4),
  created_at        timestamptz not null default now(),
  -- A closed position must carry a complete exit record.
  constraint exit_complete check (
    status = 'open' or
    (exit_price is not null and exit_date is not null and
     exit_reason is not null and net_pnl is not null)
  )
);

create table post_mortems (
  id          uuid primary key default gen_random_uuid(),
  position_id uuid not null unique references positions(id) on delete cascade,
  category    text not null check (category in
              ('thesis_wrong','thesis_right_timing_wrong','rule_violated','unmodelled_event','correct')),
  expected    text not null,
  actual      text not null,
  lesson      text not null,
  created_at  timestamptz not null default now()
);

create table reflections (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references runs(id) on delete cascade,
  book_id        text not null references books(id),
  trades_covered uuid[] not null,
  commit_sha     text,
  summary        text not null,
  rules_added    text[] not null default '{}',
  rules_retired  text[] not null default '{}',
  created_at     timestamptz not null default now()
);

create table equity_snapshots (
  book_id         text not null references books(id),
  date            date not null,
  equity          numeric(18,4) not null,
  cash            numeric(18,4) not null,
  deployed        numeric(18,4) not null,
  benchmark_value numeric(18,4),
  primary key (book_id, date)
);

create index proposals_pending_idx on proposals (book_id, status, created_at desc);
create index positions_open_idx    on positions (book_id, status);
create index positions_closed_idx  on positions (book_id, exit_date desc) where status = 'closed';
create index bars_symbol_date_idx  on daily_bars (symbol, date desc);

-- Single-owner app: any authenticated user may read; only the service role writes.
alter table books            enable row level security;
alter table instruments      enable row level security;
alter table daily_bars       enable row level security;
alter table runs             enable row level security;
alter table proposals        enable row level security;
alter table positions        enable row level security;
alter table post_mortems     enable row level security;
alter table reflections      enable row level security;
alter table equity_snapshots enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'books','instruments','daily_bars','runs','proposals',
    'positions','post_mortems','reflections','equity_snapshots'
  ] loop
    execute format('create policy %I_read on %I for select to authenticated using (true);', t, t);
  end loop;
end $$;

-- The one write the browser is allowed: deciding a pending proposal.
create policy proposals_decide on proposals
  for update to authenticated
  using (status = 'pending')
  with check (status in ('approved','rejected'));

insert into books (id, market, currency, starting_capital, cash) values
  ('nse-main', 'NSE', 'INR', 999999, 999999),
  ('us-main',  'US',  'USD', 999999, 999999);
```

The `exit_complete` constraint is the important one. It makes a half-written close — the state you get when a job crashes mid-settle — impossible to persist, so the ledger cannot silently hold a position that is neither open nor properly closed.

- [ ] **Step 2: Apply it**

Apply through the `quantrade` MCP `apply_migration` tool, named `0001_initial_schema`.

- [ ] **Step 3: Verify**

Use the `quantrade` MCP `list_tables` and confirm all nine tables exist, then
run `get_advisors` for security and performance warnings. Address anything it
flags about RLS before continuing — an unprotected table here is a public
database.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_initial_schema.sql
git commit -m "feat(db): initial schema with RLS and ledger integrity constraints"
```

---

### Task 2: Database access layer

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`
- Create: `packages/db/src/client.ts`, `src/books.ts`, `src/bars.ts`, `src/proposals.ts`, `src/positions.ts`, `src/reflections.ts`, `src/index.ts`
- Test: `packages/db/tests/mapping.test.ts`

**Interfaces:**
- Consumes: `@quantrade/core` types.
- Produces: `createDb(url, serviceKey): Db`, and on `Db`: `getBook`, `updateBookCash`, `upsertBars`, `getBars`, `insertProposals`, `getPendingProposals`, `getDecidedProposals`, `expireStaleProposals`, `insertPositions`, `getOpenPositions`, `closePositions`, `getClosedSince`, `insertPostMortem`, `insertEquitySnapshot`, `startRun`, `finishRun`, `insertReflection`, `countClosedSinceLastReflection`.
- Also produces the row mappers `toPosition`, `toProposal`, `fromPosition`, which are the pure, testable half of this package.

Supabase returns numerics as strings, and `snake_case` columns as `snake_case`
keys. Every mapping bug in this project will originate here, so the mappers are
separated from the I/O and tested on their own.

- [ ] **Step 1: Create the package**

`packages/db/package.json`:

```json
{
  "name": "@quantrade/db",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "@quantrade/core": "workspace:*",
    "@supabase/supabase-js": "^2.45.0"
  }
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing mapper test**

`packages/db/tests/mapping.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toPosition, fromPosition, toProposal } from "../src/positions.js";

const row = {
  id: "11111111-1111-1111-1111-111111111111",
  proposal_id: "22222222-2222-2222-2222-222222222222",
  book_id: "us-main",
  symbol: "AAPL",
  sector: "Technology",
  direction: "long",
  qty: 50,
  entry_price: "100.1500",
  entry_date: "2026-07-28",
  stop_loss: "90.0000",
  target: "130.0000",
  max_hold_sessions: 8,
  entry_costs: "0.0000",
  status: "closed",
  is_shadow: false,
  exit_price: "129.8000",
  exit_date: "2026-08-05",
  exit_reason: "target",
  exit_costs: "0.5600",
  gross_pnl: "1482.5000",
  net_pnl: "1481.9400",
};

describe("toPosition", () => {
  it("converts numeric strings into numbers", () => {
    const p = toPosition(row);
    expect(p.entryPrice).toBe(100.15);
    expect(p.netPnl).toBe(1481.94);
    expect(typeof p.qty).toBe("number");
  });

  it("maps snake_case to camelCase", () => {
    const p = toPosition(row);
    expect(p.maxHoldSessions).toBe(8);
    expect(p.isShadow).toBe(false);
    expect(p.exitReason).toBe("target");
  });

  it("leaves optional exit fields undefined on an open position", () => {
    const open = { ...row, status: "open", exit_price: null, exit_date: null,
                   exit_reason: null, exit_costs: null, gross_pnl: null, net_pnl: null };
    const p = toPosition(open);
    expect(p.status).toBe("open");
    expect(p.exitPrice).toBeUndefined();
    expect(p.netPnl).toBeUndefined();
  });

  it("round-trips through fromPosition without loss", () => {
    const p = toPosition(row);
    const back = fromPosition(p);
    expect(back.entry_price).toBe(100.15);
    expect(back.max_hold_sessions).toBe(8);
    expect(back.symbol).toBe("AAPL");
  });

  it("never yields NaN from a null numeric", () => {
    const p = toPosition({ ...row, gross_pnl: null });
    expect(p.grossPnl).toBeUndefined();
    expect(Number.isNaN(p.grossPnl as number)).toBe(false);
  });
});

describe("toProposal", () => {
  it("maps the falsifier and rules array", () => {
    const p = toProposal({
      id: "33333333-3333-3333-3333-333333333333",
      run_id: "44444444-4444-4444-4444-444444444444",
      book_id: "us-main", symbol: "AAPL", direction: "long",
      conviction: "0.720", stop_loss: "90.0000", target: "130.0000",
      max_hold_sessions: 8, thesis: "t", rules_applied: ["R-001"],
      falsifier: "f", signals_snapshot: {}, status: "pending",
      engine_reject_reason: null,
    });
    expect(p.conviction).toBe(0.72);
    expect(p.rulesApplied).toEqual(["R-001"]);
    expect(p.whatWouldFalsifyThis).toBe("f");
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then implement the mappers**

Run: `pnpm vitest run packages/db/tests/mapping.test.ts` — expected FAIL.

`packages/db/src/positions.ts` (mapper portion; query functions follow in Step 4):

```ts
import type { Position, Proposal } from "@quantrade/core";

/** Supabase returns numeric columns as strings. Convert exactly once, here. */
function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`Expected a numeric value, received ${String(value)}`);
  return n;
}

function required(value: unknown, field: string): number {
  const n = num(value);
  if (n === undefined) throw new Error(`Missing required numeric column "${field}"`);
  return n;
}

export function toPosition(row: Record<string, any>): Position {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    bookId: row.book_id,
    symbol: row.symbol,
    sector: row.sector,
    direction: row.direction,
    qty: required(row.qty, "qty"),
    entryPrice: required(row.entry_price, "entry_price"),
    entryDate: row.entry_date,
    stopLoss: required(row.stop_loss, "stop_loss"),
    target: required(row.target, "target"),
    maxHoldSessions: required(row.max_hold_sessions, "max_hold_sessions"),
    entryCosts: required(row.entry_costs, "entry_costs"),
    status: row.status,
    isShadow: Boolean(row.is_shadow),
    ...(num(row.exit_price) !== undefined && { exitPrice: num(row.exit_price) }),
    ...(row.exit_date && { exitDate: row.exit_date }),
    ...(row.exit_reason && { exitReason: row.exit_reason }),
    ...(num(row.exit_costs) !== undefined && { exitCosts: num(row.exit_costs) }),
    ...(num(row.gross_pnl) !== undefined && { grossPnl: num(row.gross_pnl) }),
    ...(num(row.net_pnl) !== undefined && { netPnl: num(row.net_pnl) }),
  } as Position;
}

export function fromPosition(p: Position): Record<string, unknown> {
  return {
    proposal_id: p.proposalId,
    book_id: p.bookId,
    symbol: p.symbol,
    sector: p.sector,
    direction: p.direction,
    qty: p.qty,
    entry_price: p.entryPrice,
    entry_date: p.entryDate,
    stop_loss: p.stopLoss,
    target: p.target,
    max_hold_sessions: p.maxHoldSessions,
    entry_costs: p.entryCosts,
    status: p.status,
    is_shadow: p.isShadow,
    exit_price: p.exitPrice ?? null,
    exit_date: p.exitDate ?? null,
    exit_reason: p.exitReason ?? null,
    exit_costs: p.exitCosts ?? null,
    gross_pnl: p.grossPnl ?? null,
    net_pnl: p.netPnl ?? null,
  };
}

export function toProposal(row: Record<string, any>): Proposal {
  return {
    id: row.id,
    bookId: row.book_id,
    symbol: row.symbol,
    direction: row.direction,
    conviction: required(row.conviction, "conviction"),
    stopLoss: required(row.stop_loss, "stop_loss"),
    target: required(row.target, "target"),
    maxHoldSessions: required(row.max_hold_sessions, "max_hold_sessions"),
    thesis: row.thesis,
    rulesApplied: row.rules_applied ?? [],
    whatWouldFalsifyThis: row.falsifier,
    status: row.status,
    ...(row.engine_reject_reason && { engineRejectReason: row.engine_reject_reason }),
  } as Proposal;
}
```

Run again — expected PASS, 6 tests.

- [ ] **Step 4: Implement the client and query modules**

`packages/db/src/client.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createSupabase(url: string, serviceKey: string): SupabaseClient {
  if (!url || !serviceKey) throw new Error("Supabase URL and service key are both required");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/** Throw on any Supabase error rather than returning a silent empty result —
 *  a swallowed error here becomes a day of missing trades nobody notices. */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }, context: string): T {
  if (res.error) throw new Error(`${context}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${context}: no data returned`);
  return res.data;
}
```

Write `books.ts`, `bars.ts`, `proposals.ts`, `reflections.ts` and the query half
of `positions.ts` following the same shape: each exports plain functions taking
the `SupabaseClient` as the first argument, using `unwrap` on every call and
the mappers on every row. Assemble them in `src/index.ts` as:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import * as books from "./books.js";
import * as bars from "./bars.js";
import * as proposals from "./proposals.js";
import * as positions from "./positions.js";
import * as reflections from "./reflections.js";
import { createSupabase } from "./client.js";

export function createDb(url: string, serviceKey: string) {
  const sb: SupabaseClient = createSupabase(url, serviceKey);
  return {
    getBook: (id: string) => books.getBook(sb, id),
    updateBookCash: (id: string, cash: number) => books.updateBookCash(sb, id, cash),
    insertEquitySnapshot: books.insertEquitySnapshot.bind(null, sb),
    upsertBars: bars.upsertBars.bind(null, sb),
    getBars: bars.getBars.bind(null, sb),
    insertProposals: proposals.insertProposals.bind(null, sb),
    getPendingProposals: proposals.getPending.bind(null, sb),
    getDecidedProposals: proposals.getDecided.bind(null, sb),
    expireStaleProposals: proposals.expireStale.bind(null, sb),
    startRun: proposals.startRun.bind(null, sb),
    finishRun: proposals.finishRun.bind(null, sb),
    insertPositions: positions.insertPositions.bind(null, sb),
    getOpenPositions: positions.getOpen.bind(null, sb),
    closePositions: positions.closePositions.bind(null, sb),
    getClosedSince: positions.getClosedSince.bind(null, sb),
    insertPostMortem: positions.insertPostMortem.bind(null, sb),
    countClosedSinceLastReflection: reflections.countClosedSince.bind(null, sb),
    insertReflection: reflections.insert.bind(null, sb),
  };
}

export type Db = ReturnType<typeof createDb>;
export * from "./positions.js";
```

- [ ] **Step 5: Seed the instruments table**

Write `packages/db/scripts/seed-instruments.ts` that reads the two universe
JSON files from `@quantrade/market` and upserts them into `instruments`.

Run: `pnpm tsx packages/db/scripts/seed-instruments.ts`
Verify with the `quantrade` MCP: `select count(*), market from instruments group by market`
Expected: roughly 100 rows per market.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): typed Supabase access layer with tested row mappers"
```

---

### Task 3: AGENT.md parsing, rendering, and guardrails

**Files:**
- Create: `AGENT.md`
- Create: `agent/package.json`, `agent/tsconfig.json`
- Create: `agent/src/agentmd/parse.ts`, `render.ts`, `amend.ts`, `types.ts`
- Test: `agent/tests/agentmd.test.ts`, `agent/tests/amend.test.ts`

**Interfaces:**
- Produces:
  - `interface Rule { id: string; title: string; born: string; evidence: string[]; applications: number; wins: number; avgReturn: number; status: "active" | "probation" | "retired"; retiredReason?: string }`
  - `interface AgentDoc { coreMandate: string; beliefs: string[]; rules: Rule[]; failureModes: string[] }`
  - `parseAgentDoc(markdown: string): AgentDoc`
  - `renderAgentDoc(doc: AgentDoc): string`
  - `interface Amendment { addBeliefs?: string[]; removeBeliefs?: string[]; addRules?: NewRule[]; retireRuleIds?: string[]; addFailureModes?: string[] }`
  - `applyAmendment(doc: AgentDoc, amendment: Amendment, ctx: AmendContext): { ok: true; doc: AgentDoc } | { ok: false; reason: string }`
  - `interface AmendContext { today: string; reflectionNumber: number; evidenceByRule: Record<string, string[]> }`

This is the task that decides whether the self-improvement loop is a feature or
a slow-motion failure. The guardrails must be unbypassable by prose.

- [ ] **Step 1: Author the initial `AGENT.md`**

```markdown
# QuanTrade Agent

## Core Mandate

<!-- HUMAN-ONLY. The agent must never modify this section. Verified by hash. -->

You propose swing trades on daily candles, held 2 to 10 sessions, for two
separate paper books: NSE (INR) and US (USD).

Hard limits, not preferences:

- Every proposal carries a stop loss. No stop, no trade.
- Risk per trade is 2% of book equity. You do not choose position size; the
  engine derives it from your stop.
- You do not choose an entry price. Fills happen at the next session's open.
- Maximum 8 open positions per book, 25% exposure to any sector, 60% deployed.
- NSE positions are long only.
- Standing aside is always permitted and never penalised. A day with no
  proposal is a valid outcome, and preferable to a proposal you do not believe.

Honesty obligations:

- State what would falsify each thesis, in terms observable within the holding
  period.
- Never claim a signal you were not given. You see a digest of computed
  indicators and headlines, not charts, and not intraday data.
- When you do not know, say so.

## Market Beliefs

- No beliefs recorded yet. This section fills in after the first reflection.

## Active Rules

<!-- Maximum 15. A new rule needs at least 5 supporting closed trades. -->

_No rules yet._

## Known Failure Modes

_None recorded yet._

## Retired Rules

_None yet._
```

- [ ] **Step 2: Write the failing round-trip test**

`agent/tests/agentmd.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgentDoc } from "../src/agentmd/parse.js";
import { renderAgentDoc } from "../src/agentmd/render.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "../../AGENT.md"), "utf8");

const WITH_RULES = `# QuanTrade Agent

## Core Mandate

Do not break these.

## Market Beliefs

- NSE gaps above 2% on earnings day mean-revert within 3 sessions.
- US large caps below their 200-day rarely reclaim it inside a week.

## Active Rules

### R-001 — Avoid longs into NSE earnings within 3 sessions
- **Born:** 2026-08-14 (reflection #3)
- **Evidence:** T-041, T-047, T-052, T-058, T-061
- **Since born:** 9 applications, 6 wins, +2.1% avg
- **Status:** active

### R-004 — Require volume above 1.5x on any breakout thesis
- **Born:** 2026-09-02 (reflection #5)
- **Evidence:** T-070, T-071, T-075, T-080, T-088
- **Since born:** 4 applications, 1 wins, -0.8% avg
- **Status:** probation

## Known Failure Modes

- I over-trade the first session after a losing streak.

## Retired Rules

_None yet._
`;

describe("parseAgentDoc", () => {
  it("parses the shipped AGENT.md without throwing", () => {
    const doc = parseAgentDoc(SOURCE);
    expect(doc.coreMandate).toContain("Every proposal carries a stop loss");
    expect(doc.rules).toEqual([]);
  });

  it("extracts rules with all their metadata", () => {
    const doc = parseAgentDoc(WITH_RULES);
    expect(doc.rules).toHaveLength(2);
    const r1 = doc.rules[0]!;
    expect(r1.id).toBe("R-001");
    expect(r1.title).toBe("Avoid longs into NSE earnings within 3 sessions");
    expect(r1.born).toBe("2026-08-14");
    expect(r1.evidence).toHaveLength(5);
    expect(r1.applications).toBe(9);
    expect(r1.wins).toBe(6);
    expect(r1.avgReturn).toBe(2.1);
    expect(r1.status).toBe("active");
  });

  it("reads a negative average return and a probation status", () => {
    const r2 = parseAgentDoc(WITH_RULES).rules[1]!;
    expect(r2.avgReturn).toBe(-0.8);
    expect(r2.status).toBe("probation");
  });

  it("extracts beliefs and failure modes as lists", () => {
    const doc = parseAgentDoc(WITH_RULES);
    expect(doc.beliefs).toHaveLength(2);
    expect(doc.failureModes).toHaveLength(1);
  });

  it("treats placeholder text as an empty list, not an item", () => {
    const doc = parseAgentDoc(SOURCE);
    expect(doc.beliefs.some((b) => b.includes("No beliefs recorded"))).toBe(false);
    expect(doc.failureModes).toEqual([]);
  });

  it("throws when the Core Mandate heading is missing", () => {
    expect(() => parseAgentDoc("# X\n\n## Active Rules\n")).toThrow(/core mandate/i);
  });
});

describe("render round-trip", () => {
  it("survives parse -> render -> parse unchanged", () => {
    const once = parseAgentDoc(WITH_RULES);
    const twice = parseAgentDoc(renderAgentDoc(once));
    expect(twice).toEqual(once);
  });

  it("preserves the Core Mandate byte for byte", () => {
    const doc = parseAgentDoc(WITH_RULES);
    expect(renderAgentDoc(doc)).toContain(doc.coreMandate.trim());
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then implement parse and render**

Run: `pnpm vitest run agent/tests/agentmd.test.ts` — expected FAIL.

Implement `agent/src/agentmd/types.ts`, `parse.ts`, and `render.ts`. The parser
splits on `## ` headings, reads `### R-NNN — title` blocks, and pulls the four
bold metadata fields with these patterns:

```ts
const RULE_HEAD = /^###\s+(R-\d{3})\s+—\s+(.+)$/;
const BORN      = /^-\s+\*\*Born:\*\*\s+(\d{4}-\d{2}-\d{2})/;
const EVIDENCE  = /^-\s+\*\*Evidence:\*\*\s+(.+)$/;
const SINCE     = /^-\s+\*\*Since born:\*\*\s+(\d+)\s+applications,\s+(\d+)\s+wins,\s+([+-]?[\d.]+)%\s+avg/;
const STATUS    = /^-\s+\*\*Status:\*\*\s+(active|probation|retired)/;
```

Placeholder lines — any list item or paragraph matching
`/^_?No .*(yet|recorded)/i` — parse to an empty list rather than an item.
`renderAgentDoc` re-emits those placeholders when a section is empty, which is
what makes the round-trip test pass.

Run again — expected PASS, 8 tests.

- [ ] **Step 4: Write the failing guardrail test**

`agent/tests/amend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyAmendment } from "../src/agentmd/amend.js";
import type { AgentDoc, Rule } from "../src/agentmd/types.js";

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: "R-001", title: "A rule", born: "2026-08-01",
    evidence: ["T-1", "T-2", "T-3", "T-4", "T-5"],
    applications: 10, wins: 6, avgReturn: 1.2, status: "active",
    ...over,
  };
}

function doc(over: Partial<AgentDoc> = {}): AgentDoc {
  return { coreMandate: "IMMUTABLE", beliefs: [], rules: [], failureModes: [], ...over };
}

const ctx = { today: "2026-09-01", reflectionNumber: 4, evidenceByRule: {} };

describe("evidence floor", () => {
  it("accepts a new rule backed by five closed trades", () => {
    const r = applyAmendment(
      doc(),
      { addRules: [{ title: "New rule", evidence: ["T-1","T-2","T-3","T-4","T-5"] }] },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.rules).toHaveLength(1);
      expect(r.doc.rules[0]!.id).toBe("R-001");
      expect(r.doc.rules[0]!.born).toBe("2026-09-01");
    }
  });

  it("refuses a rule backed by four", () => {
    const r = applyAmendment(
      doc(),
      { addRules: [{ title: "Anecdote", evidence: ["T-1","T-2","T-3","T-4"] }] },
      ctx,
    );
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/at least 5/i) });
  });
});

describe("rule cap", () => {
  const fifteen = Array.from({ length: 15 }, (_, i) =>
    rule({ id: `R-${String(i + 1).padStart(3, "0")}` }),
  );

  it("refuses a sixteenth active rule", () => {
    const r = applyAmendment(
      doc({ rules: fifteen }),
      { addRules: [{ title: "One too many", evidence: ["T-1","T-2","T-3","T-4","T-5"] }] },
      ctx,
    );
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/15 active rules/i) });
  });

  it("accepts an addition paired with a retirement", () => {
    const r = applyAmendment(
      doc({ rules: fifteen }),
      {
        addRules: [{ title: "Replacement", evidence: ["T-1","T-2","T-3","T-4","T-5"] }],
        retireRuleIds: ["R-001"],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.rules.filter((x) => x.status === "active")).toHaveLength(15);
      expect(r.doc.rules.find((x) => x.id === "R-001")!.status).toBe("retired");
    }
  });

  it("never reuses a retired rule's id", () => {
    const r = applyAmendment(
      doc({ rules: [rule({ id: "R-001", status: "retired" })] }),
      { addRules: [{ title: "Next", evidence: ["T-1","T-2","T-3","T-4","T-5"] }] },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.rules.some((x) => x.id === "R-002")).toBe(true);
  });
});

describe("automatic probation", () => {
  it("demotes an active rule below a 45% hit rate over 10+ applications", () => {
    const weak = rule({ id: "R-002", applications: 12, wins: 4 }); // 33%
    const r = applyAmendment(doc({ rules: [weak] }), {}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.rules[0]!.status).toBe("probation");
  });

  it("leaves a weak rule alone below 10 applications", () => {
    const young = rule({ id: "R-002", applications: 6, wins: 1 });
    const r = applyAmendment(doc({ rules: [young] }), {}, ctx);
    if (r.ok) expect(r.doc.rules[0]!.status).toBe("active");
  });

  it("retires a rule that fails again while on probation", () => {
    const failing = rule({ id: "R-002", applications: 20, wins: 6, status: "probation" });
    const r = applyAmendment(doc({ rules: [failing] }), {}, ctx);
    if (r.ok) expect(r.doc.rules[0]!.status).toBe("retired");
  });

  it("restores a probation rule that recovers", () => {
    const recovered = rule({ id: "R-002", applications: 20, wins: 14, status: "probation" });
    const r = applyAmendment(doc({ rules: [recovered] }), {}, ctx);
    if (r.ok) expect(r.doc.rules[0]!.status).toBe("active");
  });
});

describe("core mandate immutability", () => {
  it("carries the mandate through untouched", () => {
    const r = applyAmendment(doc({ coreMandate: "IMMUTABLE" }), { addBeliefs: ["x"] }, ctx);
    if (r.ok) expect(r.doc.coreMandate).toBe("IMMUTABLE");
  });

  it("has no amendment field capable of reaching it", () => {
    const amendment = { coreMandate: "hacked" } as never;
    const r = applyAmendment(doc({ coreMandate: "IMMUTABLE" }), amendment, ctx);
    if (r.ok) expect(r.doc.coreMandate).toBe("IMMUTABLE");
  });
});

describe("beliefs and failure modes", () => {
  it("adds and removes beliefs", () => {
    const r = applyAmendment(
      doc({ beliefs: ["old"] }),
      { addBeliefs: ["new"], removeBeliefs: ["old"] },
      ctx,
    );
    if (r.ok) expect(r.doc.beliefs).toEqual(["new"]);
  });

  it("caps beliefs at 20 to stop unbounded accretion", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `belief ${i}`);
    const r = applyAmendment(doc({ beliefs: twenty }), { addBeliefs: ["one more"] }, ctx);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/20 beliefs/i) });
  });
});
```

- [ ] **Step 5: Implement `amend.ts`**

The shape that makes the immutability test pass is structural: `Amendment` has
no field that touches `coreMandate`, and `applyAmendment` copies it across
verbatim. Prompt wording is irrelevant — there is no code path to it.

```ts
export const MAX_ACTIVE_RULES = 15;
export const MAX_BELIEFS = 20;
export const MIN_EVIDENCE = 5;
export const PROBATION_HIT_RATE = 0.45;
export const MIN_APPLICATIONS_TO_JUDGE = 10;
```

Order of operations inside `applyAmendment`, which the tests pin:

1. Apply retirements from `retireRuleIds`.
2. Re-evaluate every remaining rule's status against its hit rate
   (active → probation → retired, and probation → active on recovery).
3. Validate additions: evidence floor first, then the active-rule cap counted
   *after* step 1, so an add-plus-retire pair fits.
4. Mint new rule IDs as `R-` plus the highest existing numeric suffix + 1,
   including retired rules, so IDs are never reused.
5. Apply belief and failure-mode changes, enforcing `MAX_BELIEFS`.
6. Return a new document with `coreMandate` copied unchanged.

Run: `pnpm vitest run agent/tests/amend.test.ts` — expected PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add AGENT.md agent
git commit -m "feat(agent): AGENT.md parser, renderer, and enforced amendment guardrails"
```

---

### Task 4: LLM client with failover

**Files:**
- Create: `agent/src/llm/client.ts`, `agent/src/llm/prompts.ts`
- Test: `agent/tests/llm.test.ts`

**Interfaces:**
- Consumes: `AgentResponseSchema` from `@quantrade/core`.
- Produces:
  - `interface LlmProvider { name: string; complete(system: string, user: string): Promise<{ text: string; tokens: number }> }`
  - `class GroqProvider implements LlmProvider`, `class GeminiProvider implements LlmProvider`
  - `askForProposals(providers: LlmProvider[], system: string, user: string): Promise<{ response: AgentResponse; model: string; tokens: number }>`
  - `buildProposalPrompt(input): { system: string; user: string }` from `prompts.ts`

- [ ] **Step 1: Write the failing client test**

`agent/tests/llm.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { askForProposals } from "../src/llm/client.js";
import type { LlmProvider } from "../src/llm/client.js";

const VALID = JSON.stringify({
  market_view: "Quiet.",
  proposals: [{
    symbol: "AAPL", direction: "long", conviction: 0.6,
    stop_loss: 190, target: 230, max_hold_sessions: 7,
    thesis: "Reclaimed the 200-day.", rules_applied: [],
    what_would_falsify_this: "A close back below 190.",
  }],
});

function provider(name: string, texts: string[]): LlmProvider {
  const queue = [...texts];
  return {
    name,
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error(`${name} exhausted`);
      if (next === "THROW") throw new Error(`${name} is down`);
      return { text: next, tokens: 100 };
    }),
  };
}

describe("askForProposals", () => {
  it("returns a parsed response from the primary", async () => {
    const r = await askForProposals([provider("groq", [VALID])], "s", "u");
    expect(r.model).toBe("groq");
    expect(r.response.proposals[0]?.symbol).toBe("AAPL");
  });

  it("strips a markdown code fence before parsing", async () => {
    const fenced = "```json\n" + VALID + "\n```";
    const r = await askForProposals([provider("groq", [fenced])], "s", "u");
    expect(r.response.proposals).toHaveLength(1);
  });

  it("retries the same provider once with the validation error appended", async () => {
    const p = provider("groq", ["{ not json", VALID]);
    const r = await askForProposals([p], "s", "u");
    expect(r.response.proposals).toHaveLength(1);
    expect(p.complete).toHaveBeenCalledTimes(2);
    const secondUser = (p.complete as any).mock.calls[1][1] as string;
    expect(secondUser).toMatch(/previous response/i);
  });

  it("fails over to the next provider when the first throws", async () => {
    const groq = provider("groq", ["THROW"]);
    const gemini = provider("gemini", [VALID]);
    const r = await askForProposals([groq, gemini], "s", "u");
    expect(r.model).toBe("gemini");
  });

  it("fails over when the first provider cannot produce valid JSON twice", async () => {
    const groq = provider("groq", ["garbage", "still garbage"]);
    const gemini = provider("gemini", [VALID]);
    const r = await askForProposals([groq, gemini], "s", "u");
    expect(r.model).toBe("gemini");
  });

  it("throws when every provider is exhausted", async () => {
    const groq = provider("groq", ["THROW"]);
    const gemini = provider("gemini", ["THROW"]);
    await expect(askForProposals([groq, gemini], "s", "u"))
      .rejects.toThrow(/all providers failed/i);
  });

  it("rejects a schema-valid shape carrying an impossible proposal", async () => {
    // Long with a target below its stop — schema-level contradiction.
    const bad = JSON.stringify({
      market_view: "x",
      proposals: [{
        symbol: "AAPL", direction: "long", conviction: 0.6,
        stop_loss: 230, target: 190, max_hold_sessions: 7,
        thesis: "t", rules_applied: [], what_would_falsify_this: "f",
      }],
    });
    const groq = provider("groq", [bad, bad]);
    const gemini = provider("gemini", [VALID]);
    const r = await askForProposals([groq, gemini], "s", "u");
    expect(r.model).toBe("gemini");
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then implement `client.ts`**

Run: `pnpm vitest run agent/tests/llm.test.ts` — expected FAIL.

```ts
import { AgentResponseSchema, type AgentResponse } from "@quantrade/core";

export interface LlmProvider {
  readonly name: string;
  complete(system: string, user: string): Promise<{ text: string; tokens: number }>;
}

/** Models wrap JSON in prose or fences no matter how firmly you ask them not to. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}

export async function askForProposals(
  providers: LlmProvider[],
  system: string,
  user: string,
): Promise<{ response: AgentResponse; model: string; tokens: number }> {
  const failures: string[] = [];

  for (const provider of providers) {
    let prompt = user;

    // Two attempts per provider: the second carries the validation error, which
    // models correct reliably. A third attempt is throwing tokens at a model
    // that has misunderstood the task.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text, tokens } = await provider.complete(system, prompt);
        const parsed = AgentResponseSchema.safeParse(JSON.parse(extractJson(text)));
        if (parsed.success) {
          return { response: parsed.data, model: provider.name, tokens };
        }
        prompt =
          `${user}\n\nYour previous response was rejected by the validator:\n` +
          `${parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}\n` +
          `Return only valid JSON matching the schema.`;
        failures.push(`${provider.name} attempt ${attempt + 1}: schema rejection`);
      } catch (err) {
        failures.push(`${provider.name} attempt ${attempt + 1}: ${(err as Error).message}`);
        break; // a thrown error is transport-level; retrying the prompt will not help
      }
    }
  }

  throw new Error(`All providers failed:\n${failures.join("\n")}`);
}

export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  constructor(private key: string, private model = "llama-3.3-70b-versatile") {}

  async complete(system: string, user: string) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Groq responded ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      tokens: body.usage?.total_tokens ?? 0,
    };
  }
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  constructor(private key: string, private model = "gemini-2.0-flash") {}

  async complete(system: string, user: string) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) throw new Error(`Gemini responded ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    return {
      text: body.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
      tokens: body.usageMetadata?.totalTokenCount ?? 0,
    };
  }
}
```

Run again — expected PASS, 7 tests.

- [ ] **Step 3: Write `prompts.ts`**

`buildProposalPrompt` assembles the system and user messages. The system
message is the full `AGENT.md` text plus the output contract. The user message
carries the digest, the news, and the book state.

```ts
export interface ProposalPromptInput {
  agentMd: string;
  market: "NSE" | "US";
  asOfDate: string;
  digest: string;
  news: Record<string, Array<{ title: string; publisher: string }>>;
  cash: number;
  currency: string;
  openPositions: Array<{ symbol: string; direction: string; daysHeld: number; unrealisedPct: number }>;
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
    '    "symbol": "exactly as given in the digest",',
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
    "You do not set entry price or position size — the engine does both.",
    "Only propose symbols present in the digest below.",
  ].join("\n");

  const user = [
    `Market: ${input.market}. Decision date: ${input.asOfDate}.`,
    `Available cash: ${input.cash.toLocaleString()} ${input.currency}.`,
    "",
    "## Candidates",
    input.digest,
    "",
    "## Recent headlines",
    Object.entries(input.news)
      .map(([sym, items]) =>
        items.length === 0
          ? `${sym}: no recent coverage`
          : `${sym}:\n${items.map((n) => `  - ${n.title} (${n.publisher})`).join("\n")}`,
      )
      .join("\n"),
    "",
    "## Open positions",
    input.openPositions.length === 0
      ? "None."
      : input.openPositions
          .map((p) => `- ${p.symbol} ${p.direction}, ${p.daysHeld} sessions held, ${p.unrealisedPct.toFixed(1)}% unrealised`)
          .join("\n"),
    "",
    "## Your last 10 closed trades",
    input.recentOutcomes.length === 0
      ? "No closed trades yet."
      : input.recentOutcomes
          .map((o) => `- ${o.symbol}: ${o.netPct.toFixed(1)}% net, exited on ${o.exitReason}, post-mortem: ${o.category}`)
          .join("\n"),
  ].join("\n");

  return { system, user };
}
```

Add `agent/tests/prompts.test.ts` asserting: the system message contains the
Core Mandate text, the user message contains every digest symbol, an empty
news map renders "no recent coverage" rather than an empty section, and the
combined length for 15 candidates stays under 20,000 characters.

- [ ] **Step 4: Commit**

```bash
git add agent/src/llm agent/tests/llm.test.ts agent/tests/prompts.test.ts
git commit -m "feat(agent): LLM client with retry, failover, and the proposal prompt"
```

---

### Task 5: The propose job

**Files:**
- Create: `agent/src/jobs/propose.ts`, `agent/src/cli.ts`
- Test: `agent/tests/propose.test.ts`

**Interfaces:**
- Consumes: `createDataSource`, `computeFeatures`, `rankCandidates`, `buildDigest`, `askForProposals`, `buildProposalPrompt`, `validateProposal`, `Db`.
- Produces: `runPropose(deps: ProposeDeps, market: Market, asOfDate: string): Promise<ProposeResult>` where `ProposeDeps = { db: Db; data: MarketAdapter; providers: LlmProvider[]; agentMd: string; notify: (msg: string) => Promise<void> }`.

Everything external is injected. The test supplies fakes for all four, so the
whole job runs offline in milliseconds.

- [ ] **Step 1: Write the failing job test**

`agent/tests/propose.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runPropose } from "../src/jobs/propose.js";

function fakeDeps(over: any = {}) {
  const inserted: any[] = [];
  return {
    inserted,
    deps: {
      db: {
        startRun: vi.fn(async () => "run-1"),
        finishRun: vi.fn(async () => {}),
        getBook: vi.fn(async () => ({
          id: "us-main", market: "US", currency: "USD",
          startingCapital: 999999, cash: 999999,
        })),
        getBars: vi.fn(async () => []),
        upsertBars: vi.fn(async () => {}),
        getOpenPositions: vi.fn(async () => []),
        getClosedSince: vi.fn(async () => []),
        insertProposals: vi.fn(async (rows: any[]) => { inserted.push(...rows); }),
        expireStaleProposals: vi.fn(async () => 0),
        ...over.db,
      },
      data: {
        name: "fake",
        dailyBars: vi.fn(async (symbol: string) =>
          Array.from({ length: 260 }, (_, i) => ({
            symbol, date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
            open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1,
            close: 100 + i * 0.1, volume: 1000,
          })),
        ),
        news: vi.fn(async () => []),
        ...over.data,
      },
      providers: over.providers ?? [{
        name: "fake-llm",
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            market_view: "Trending.",
            proposals: [{
              symbol: "AAPL", direction: "long", conviction: 0.7,
              stop_loss: 100, target: 160, max_hold_sessions: 7,
              thesis: "t", rules_applied: [], what_would_falsify_this: "f",
            }],
          }),
          tokens: 500,
        })),
      }],
      agentMd: "# Agent\n\n## Core Mandate\n\nRules.\n",
      notify: vi.fn(async () => {}),
      universe: [
        { symbol: "AAPL", name: "Apple", sector: "Technology" },
        { symbol: "MSFT", name: "Microsoft", sector: "Technology" },
      ],
      ...over.root,
    },
  };
}

describe("runPropose", () => {
  it("persists proposals returned by the agent", async () => {
    const { deps, inserted } = fakeDeps();
    const r = await runPropose(deps as any, "US", "2026-07-28");
    expect(r.status).toBe("ok");
    expect(inserted).toHaveLength(1);
    expect(inserted[0].symbol).toBe("AAPL");
    expect(inserted[0].status).toBe("pending");
  });

  it("stores the signals snapshot alongside each proposal", async () => {
    const { deps, inserted } = fakeDeps();
    await runPropose(deps as any, "US", "2026-07-28");
    expect(inserted[0].signals_snapshot).toBeTruthy();
    expect(inserted[0].signals_snapshot.symbol).toBe("AAPL");
  });

  it("drops a proposal for a symbol that was never in the digest", async () => {
    const { deps, inserted } = fakeDeps({
      providers: [{
        name: "hallucinator",
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            market_view: "x",
            proposals: [{
              symbol: "TSLA", direction: "long", conviction: 0.9,
              stop_loss: 100, target: 200, max_hold_sessions: 5,
              thesis: "t", rules_applied: [], what_would_falsify_this: "f",
            }],
          }),
          tokens: 100,
        })),
      }],
    });
    const r = await runPropose(deps as any, "US", "2026-07-28");
    expect(inserted).toHaveLength(0);
    expect(r.dropped).toContain("TSLA");
  });

  it("records engine_rejected instead of pending when a limit is breached", async () => {
    const { deps, inserted } = fakeDeps({
      providers: [{
        name: "risky",
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            market_view: "x",
            proposals: [{
              symbol: "AAPL", direction: "long", conviction: 0.9,
              stop_loss: 200, target: 300, max_hold_sessions: 5, // stop above entry
              thesis: "t", rules_applied: [], what_would_falsify_this: "f",
            }],
          }),
          tokens: 100,
        })),
      }],
    });
    await runPropose(deps as any, "US", "2026-07-28");
    expect(inserted[0].status).toBe("engine_rejected");
    expect(inserted[0].engine_reject_reason).toMatch(/stop/i);
  });

  it("records a clean no-trade day without inserting anything", async () => {
    const { deps, inserted } = fakeDeps({
      providers: [{
        name: "cautious",
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            market_view: "Nothing here.",
            proposals: [],
            no_trade_reason: "No candidate cleared the volume filter.",
          }),
          tokens: 80,
        })),
      }],
    });
    const r = await runPropose(deps as any, "US", "2026-07-28");
    expect(r.status).toBe("ok");
    expect(r.noTradeReason).toMatch(/volume filter/);
    expect(inserted).toHaveLength(0);
  });

  it("marks the run failed and notifies when data collection breaks", async () => {
    const { deps } = fakeDeps({
      data: { dailyBars: vi.fn(async () => { throw new Error("Yahoo down"); }) },
    });
    const r = await runPropose(deps as any, "US", "2026-07-28");
    expect(r.status).toBe("failed");
    expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/failed/i));
    expect(deps.db.finishRun).toHaveBeenCalledWith("run-1", "failed", expect.anything());
  });

  it("notifies once when proposals are waiting for a decision", async () => {
    const { deps } = fakeDeps();
    await runPropose(deps as any, "US", "2026-07-28");
    expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/1 proposal/i));
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then implement `propose.ts`**

Run: `pnpm vitest run agent/tests/propose.test.ts` — expected FAIL.

The job's sequence:

1. `startRun(bookId, "propose")`.
2. `expireStaleProposals(bookId)` — anything still pending from a prior session.
3. For every universe symbol: read cached bars from the DB, fetch only the
   missing tail from the adapter, `upsertBars` the new ones. This is what keeps
   request volume low enough to stay welcome on a free endpoint.
4. `computeFeatures` per symbol, `rankCandidates(features, 15)`.
5. Fetch news for the 15 survivors only.
6. `buildProposalPrompt` → `askForProposals`.
7. **Drop any proposal whose symbol was not among the 15.** A hallucinated
   ticker is not a trade idea, and this check is the only thing standing between
   the model and a position in a company that does not exist.
8. Run `validateProposal` on each survivor using the *previous* close as a
   stand-in entry. Failures persist as `engine_rejected` with the reason, so the
   agent sees the constraint in tomorrow's context instead of rediscovering it.
9. Insert survivors as `pending` with `expires_at` set to 15 minutes before the
   session open, attaching the symbol's `SymbolFeatures` as `signals_snapshot`.
10. `notify` if anything is pending; `finishRun(runId, "ok" | "failed")`.

Any throw is caught at the top level, recorded via `finishRun(..., "failed", message)`,
notified, and returned as `{ status: "failed" }`. The job never rethrows — a
crashed workflow gives you a red tick and no explanation.

Run again — expected PASS, 7 tests.

- [ ] **Step 3: Write the CLI entry point**

`agent/src/cli.ts` reads env vars, constructs the real dependencies, and
dispatches on `process.argv`:

```
node dist/cli.js propose US
node dist/cli.js settle NSE
node dist/cli.js reflect US
```

It exits non-zero only on a *configuration* error (missing env var). A trading
run that fails for data or model reasons exits zero, having already recorded
and notified the failure — otherwise GitHub emails a workflow failure for
something the system already handled and reported.

- [ ] **Step 4: Commit**

```bash
git add agent/src/jobs/propose.ts agent/src/cli.ts agent/tests/propose.test.ts
git commit -m "feat(agent): propose job with hallucination and risk-limit filtering"
```

---

### Task 6: The settle job

**Files:**
- Create: `agent/src/jobs/settle.ts`
- Test: `agent/tests/settle.test.ts`

**Interfaces:**
- Consumes: `settle` from `@quantrade/portfolio`, `Db`, `MarketAdapter`, `askForProposals`.
- Produces: `runSettle(deps, market, asOfDate): Promise<SettleJobResult>`.

- [ ] **Step 1: Write the failing test**

`agent/tests/settle.test.ts` must cover, with injected fakes throughout:

```ts
describe("runSettle", () => {
  it("opens approved proposals as real positions", async () => { /* … */ });

  it("opens rejected and expired proposals as shadow positions", async () => {
    // Both statuses become positions with is_shadow true, and neither
    // touches book cash.
  });

  it("leaves pending proposals untouched", async () => { /* … */ });

  it("writes a post-mortem for every position closed this session", async () => {
    // One insertPostMortem call per closed position, each carrying one of the
    // five allowed categories.
  });

  it("does not write post-mortems for shadow positions", async () => {
    // Shadow trades are measured, not reflected on — they were never the
    // agent's decision to own.
  });

  it("persists exactly one equity snapshot for the date", async () => { /* … */ });

  it("records the benchmark value on the snapshot", async () => {
    // ^NSEI for NSE, SPY for US. The snapshot carries the index close scaled to
    // the book's starting capital, so the Performance chart can plot
    // buy-and-hold against the agent without any client-side arithmetic.
  });

  it("still writes the snapshot when the benchmark fetch fails", async () => {
    // benchmark_value is nullable. Losing the index quote must not cost us the
    // day's equity record — the chart can interpolate, the ledger cannot.
  });

  it("updates book cash to the engine's result", async () => { /* … */ });

  it("triggers a reflection when the book crosses 10 closed trades", async () => {
    // countClosedSinceLastReflection returns 10 -> result.shouldReflect is true
  });

  it("does not trigger a reflection at 9", async () => { /* … */ });

  it("skips entirely on a non-session day", async () => {
    // isSessionDay false -> status "skipped", no writes at all
  });

  it("fails the run without writing when bars are missing for held symbols", async () => {
    // A partial settle is worse than no settle: it would mark some positions
    // and not others, then double-count on the retry.
  });
});
```

Write each of these as a real test with fakes modelled on Task 5's `fakeDeps`.

- [ ] **Step 2: Implement `settle.ts`**

Sequence:

1. Return `{ status: "skipped" }` immediately if `isSessionDay(market, date)` is false.
2. `startRun(bookId, "settle")`.
3. Load open positions (real and shadow), and proposals decided since the last settle.
4. Fetch today's bars for every held symbol plus every symbol about to be opened.
   **If any is missing, fail the whole run without writing anything.**
5. Call `settle()` from `@quantrade/portfolio` with the assembled world.
6. Fetch the benchmark close — `^NSEI` for NSE, `SPY` for US — and scale it to
   the book's starting capital using the first snapshot's index level as the
   base. Wrap this in its own try/catch: `benchmark_value` is nullable and a
   missing index quote must never cost the day's equity record.
7. Persist in one logical sweep: insert opened positions, close the closed ones,
   update book cash, insert the equity snapshot with its benchmark value.
8. For each closed non-shadow position, call the LLM once for a post-mortem
   constrained to the five categories, and insert it.
9. `countClosedSinceLastReflection` → set `shouldReflect` when it reaches 10.
10. Notify with a one-line summary; `finishRun`.

Step 4's all-or-nothing rule is the important one. A settle that half-completes
leaves positions marked on different dates, and the retry then double-counts
the ones it already closed.

- [ ] **Step 3: Run the tests and commit**

Run: `pnpm vitest run agent/tests/settle.test.ts` — expected PASS.

```bash
git add agent/src/jobs/settle.ts agent/tests/settle.test.ts
git commit -m "feat(agent): settle job with shadow book, post-mortems, and atomic writes"
```

---

### Task 7: The reflection job

**Files:**
- Create: `agent/src/jobs/reflect.ts`, `agent/src/git.ts`
- Test: `agent/tests/reflect.test.ts`

**Interfaces:**
- Consumes: `parseAgentDoc`, `renderAgentDoc`, `applyAmendment`, `askForProposals` (reused with an amendment schema), `Db`.
- Produces: `runReflect(deps, market): Promise<ReflectResult>`, `commitAgentMd(message: string, body: string): Promise<string>` returning the commit SHA.

- [ ] **Step 1: Define the amendment response schema**

Add to `agent/src/agentmd/types.ts`:

```ts
import { z } from "zod";

export const AmendmentResponseSchema = z.object({
  summary: z.string().min(1),
  add_beliefs: z.array(z.string()).default([]),
  remove_beliefs: z.array(z.string()).default([]),
  add_rules: z.array(z.object({
    title: z.string().min(1),
    evidence: z.array(z.string()).min(1),
  })).default([]),
  retire_rule_ids: z.array(z.string()).default([]),
  add_failure_modes: z.array(z.string()).default([]),
});
```

There is deliberately no field for the Core Mandate. The model cannot request
a change it has no way to express.

- [ ] **Step 2: Write the failing reflection test**

`agent/tests/reflect.test.ts` covers:

```ts
describe("runReflect", () => {
  it("amends AGENT.md and commits with the summary as the message", async () => { /* … */ });

  it("records the commit SHA on the reflections row", async () => { /* … */ });

  it("refuses an amendment that breaches the evidence floor and commits nothing", async () => {
    // applyAmendment returns not-ok -> no file write, no commit,
    // reflections row still inserted with the refusal in its summary so the
    // attempt is not invisible.
  });

  it("leaves the Core Mandate byte-identical after a write", async () => {
    // Read the file back and compare a hash taken before the write.
  });

  it("excludes unmodelled_event trades from rule evidence", async () => {
    // A post-mortem categorised unmodelled_event must not appear in the
    // evidence list offered to the model.
  });

  it("applies automatic probation even when the model proposes nothing", async () => {
    // An empty amendment still runs the hit-rate re-evaluation and can commit.
  });

  it("makes no commit when the document is unchanged", async () => { /* … */ });
});
```

- [ ] **Step 3: Implement `reflect.ts` and `git.ts`**

`reflect.ts` sequence:

1. Load post-mortems since the last reflection, **excluding `unmodelled_event`**.
2. Read and parse `AGENT.md`; hash the Core Mandate.
3. Build the reflection prompt: the current document, the post-mortems grouped
   by category, and each active rule's hit rate.
4. Call the LLM, validate against `AmendmentResponseSchema`.
5. `applyAmendment` — the guardrails from Task 3 decide what survives.
6. If refused, insert the reflections row with the refusal recorded and stop.
7. If accepted, render, verify the Core Mandate hash is unchanged, write the
   file, and commit.
8. Insert the reflections row with the resulting SHA.

`git.ts` shells out with `execFile`, configuring `user.name`
`quantrade-agent` and `user.email` `agent@quantrade.local` so the agent's
commits are visibly distinct from yours in `git log`.

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export async function commitAgentMd(message: string, body: string): Promise<string> {
  await run("git", ["config", "user.name", "quantrade-agent"]);
  await run("git", ["config", "user.email", "agent@quantrade.local"]);
  await run("git", ["add", "AGENT.md"]);
  await run("git", ["commit", "-m", message, "-m", body]);
  const { stdout } = await run("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}
```

- [ ] **Step 4: Run the tests and commit**

```bash
git add agent/src/jobs/reflect.ts agent/src/git.ts agent/tests/reflect.test.ts
git commit -m "feat(agent): reflection job committing guarded AGENT.md amendments"
```

---

### Task 8: Telegram notifications

**Files:**
- Create: `agent/src/notify/telegram.ts`
- Test: `agent/tests/telegram.test.ts`

**Interfaces:**
- Produces: `createNotifier(token: string, chatId: string): (message: string) => Promise<void>`, and `createNullNotifier()` for local runs.

- [ ] **Step 1: Write the test**

```ts
describe("createNotifier", () => {
  it("posts the message to the bot API", async () => { /* assert URL and body */ });
  it("escapes Markdown so a stock name with an underscore does not break the message", async () => { /* … */ });
  it("swallows a delivery failure rather than failing the trading run", async () => {
    // A dead Telegram must never take down a settle.
  });
  it("truncates messages beyond the 4096-character limit", async () => { /* … */ });
});

describe("createNullNotifier", () => {
  it("resolves without any network call", async () => { /* … */ });
});
```

- [ ] **Step 2: Implement, run, commit**

```ts
export function createNotifier(token: string, chatId: string) {
  return async (message: string): Promise<void> => {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message.slice(0, 4096),
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      // Notification is a convenience. Losing it must never cost a trading run.
      console.error(`Telegram delivery failed: ${(err as Error).message}`);
    }
  };
}
```

```bash
git add agent/src/notify agent/tests/telegram.test.ts
git commit -m "feat(agent): Telegram notifier that fails soft"
```

---

### Task 9: Scheduled workflows

**Files:**
- Create: `.github/workflows/trading.yml`
- Modify: `package.json` (add a `build:agent` script)

- [ ] **Step 1: Write the workflow**

`.github/workflows/trading.yml`:

```yaml
name: QuanTrade

on:
  schedule:
    - cron: "15 3 * * 1-5"   # 08:45 IST — propose NSE
    - cron: "15 10 * * 1-5"  # 15:45 IST — settle NSE
    - cron: "30 12 * * 1-5"  # 18:00 IST — propose US
    - cron: "15 21 * * 1-5"  # 02:45 IST — settle US
  workflow_dispatch:
    inputs:
      job:    { description: "propose | settle | reflect", required: true, default: "propose" }
      market: { description: "NSE | US", required: true, default: "US" }

concurrency:
  group: quantrade-${{ github.ref }}
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    permissions:
      contents: write   # the reflection job commits AGENT.md
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - uses: pnpm/action-setup@v4
        with: { version: 9 }

      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }

      - run: pnpm install --frozen-lockfile

      - name: Decide the job from the schedule
        id: decide
        run: |
          case "${{ github.event.schedule }}" in
            "15 3 * * 1-5")   echo "job=propose" >> $GITHUB_OUTPUT; echo "market=NSE" >> $GITHUB_OUTPUT ;;
            "15 10 * * 1-5")  echo "job=settle"  >> $GITHUB_OUTPUT; echo "market=NSE" >> $GITHUB_OUTPUT ;;
            "30 12 * * 1-5")  echo "job=propose" >> $GITHUB_OUTPUT; echo "market=US"  >> $GITHUB_OUTPUT ;;
            "15 21 * * 1-5")  echo "job=settle"  >> $GITHUB_OUTPUT; echo "market=US"  >> $GITHUB_OUTPUT ;;
            *) echo "job=${{ inputs.job }}" >> $GITHUB_OUTPUT; echo "market=${{ inputs.market }}" >> $GITHUB_OUTPUT ;;
          esac

      - name: Run
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
        run: pnpm tsx agent/src/cli.ts ${{ steps.decide.outputs.job }} ${{ steps.decide.outputs.market }}

      - name: Push any AGENT.md amendment
        if: steps.decide.outputs.job == 'reflect'
        run: git push origin HEAD:main
```

Two notes on this file. `cancel-in-progress: false` matters because a settle
cancelled halfway is exactly the partial write Task 6 works to prevent. And
GitHub's scheduler routinely runs cron jobs several minutes late under load,
which is why the propose jobs sit 30–60 minutes ahead of the open rather than
5 — a proposal that arrives after the bell is worthless.

- [ ] **Step 2: Configure repository secrets**

Add all six secrets under Settings → Secrets and variables → Actions. Obtain
the Telegram chat ID by messaging the bot once and reading
`https://api.telegram.org/bot<TOKEN>/getUpdates`.

- [ ] **Step 3: Smoke test**

Trigger `workflow_dispatch` with `job=propose`, `market=US`. Confirm: the run
is green, a `runs` row exists with status `ok`, and a Telegram message arrives.
Then verify a failure path by temporarily setting an invalid `GROQ_API_KEY` and
confirming the run still exits zero while recording `failed` and notifying.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/trading.yml
git commit -m "ci: scheduled propose, settle, and reflect workflows"
```

---

## Definition of Done

- [ ] `pnpm test` green across all six packages plus `agent`.
- [ ] No test touches the network, a real database, or a real LLM. Verify with the wifi off.
- [ ] All nine tables exist in `kdjghlybcecvzowxzsqz` with RLS enabled, and `get_advisors` reports no security findings.
- [ ] A manual `workflow_dispatch` propose run completes green and delivers a Telegram message.
- [ ] A deliberately broken API key produces a recorded `failed` run, a notification, and a zero exit code.
- [ ] `AGENT.md` exists, parses, and round-trips.
- [ ] Nine commits exist, one per task.

## What this plan deliberately does not build

The web cockpit. Until Plan 4 lands, proposals can only be approved by updating
the row directly — which is fine for verifying the pipeline, and is exactly why
approval is a database state rather than application logic.

