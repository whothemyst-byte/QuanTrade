# QuanTrade Plan 1 — Simulation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic paper-trading simulator — calendars, cost model, position sizing, fill logic, and the portfolio ledger — with zero network and zero LLM dependencies.

**Architecture:** A pnpm/TypeScript monorepo. This plan builds `@quantrade/core` (shared types and Zod schemas) and `@quantrade/portfolio` (the simulator). Every function here is pure: the current time and the market data are always arguments, never ambient. That purity is what makes the golden-replay test in Task 7 possible, and the golden-replay test is what makes every P&L number in the project trustworthy.

**Tech Stack:** TypeScript 5.x (strict), pnpm workspaces, Vitest, Zod 3.x. No runtime dependencies beyond Zod.

## Global Constraints

- **Zero cost.** No dependency that requires a paid account, an API key, or a trial. If a task seems to need one, stop and raise it.
- **No network in this plan.** Every test runs offline. Any `fetch` in `packages/core` or `packages/portfolio` is a bug.
- **No look-ahead.** A fill may only ever use bars dated on or after the decision date. Never the bar the decision was made from.
- **Conservative tie-break.** If a session's high touches the target and its low touches the stop, the stop wins. Always.
- **Gap-through:** if a session opens beyond the stop, the fill price is the open, not the stop.
- **Risk per trade:** 2% of book equity. **Position value cap:** 5% of equity. **Sector cap:** 25%. **Deployed cap:** 60%. **Max open positions:** 8 per book.
- **Max hold:** 10 sessions, or the proposal's `maxHoldSessions`, whichever is sooner.
- **NSE shorts are invalid** and must be rejected by the engine. US shorts are allowed.
- **Money rounding:** every monetary value is rounded to 2 decimal places via `round2()` at each computation boundary. Quantities are always integers.
- **Slippage:** 0.15% each way, both markets.
- Spec: `docs/specs/2026-07-28-quantrade-design.md`. Where this plan and the spec disagree, the spec wins — stop and flag it.

---

## File Structure

```
QuanTrade/
├─ package.json                       # pnpm workspace root, scripts
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ vitest.workspace.ts
├─ packages/
│  ├─ core/
│  │  ├─ package.json
│  │  ├─ src/index.ts                 # barrel
│  │  ├─ src/types.ts                 # Market, Direction, Bar, Book, Position…
│  │  ├─ src/schemas.ts               # Zod schemas + AgentResponse
│  │  ├─ src/money.ts                 # round2, currency helpers
│  │  └─ tests/schemas.test.ts
│  └─ portfolio/
│     ├─ package.json
│     ├─ src/index.ts                 # barrel
│     ├─ src/calendar.ts              # session logic
│     ├─ src/calendars/nse.json       # holiday list
│     ├─ src/calendars/us.json
│     ├─ src/costs.ts                 # per-market cost model
│     ├─ src/sizing.ts                # qty derivation + risk limits
│     ├─ src/fills.ts                 # entry/exit price resolution
│     ├─ src/engine.ts                # settle(): the orchestrator
│     └─ tests/…                      # one test file per src module
└─ docs/
```

Each `src` module has exactly one responsibility and one test file. `engine.ts` is the only module that composes the others; everything below it is a leaf that can be understood alone.

---

### Task 1: Monorepo scaffold and core types

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/types.ts`, `packages/core/src/money.ts`, `packages/core/src/schemas.ts`, `packages/core/src/index.ts`
- Test: `packages/core/tests/money.test.ts`, `packages/core/tests/schemas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type and schema used by the rest of the project. `Market`, `Direction`, `ExitReason`, `Bar`, `Book`, `Proposal`, `Position`, `CostBreakdown`, `round2()`, `ProposalSchema`, `AgentResponseSchema`, `BarSchema`.

- [ ] **Step 1: Create the workspace root**

`package.json`:

```json
{
  "name": "quantrade",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  },
  "packageManager": "pnpm@9.12.0"
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "agent"
  - "apps/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

`vitest.workspace.ts`:

```ts
export default ["packages/*"];
```

`.gitignore`:

```
node_modules/
dist/
.next/
.env
.env.local
*.tsbuildinfo
.vercel/
```

`noUncheckedIndexedAccess` is deliberate. This codebase indexes into bar arrays constantly, and a missing bar must be a compile error rather than a silent `undefined` that becomes `NaN` in a P&L figure.

- [ ] **Step 2: Create the core package**

`packages/core/package.json`:

```json
{
  "name": "@quantrade/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "zod": "^3.23.0"
  }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

Run: `pnpm install`

- [ ] **Step 3: Write the failing money test**

`packages/core/tests/money.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { round2 } from "../src/money.js";

describe("round2", () => {
  it("rounds to two decimal places", () => {
    expect(round2(10.005)).toBe(10.01);
    expect(round2(10.004)).toBe(10.0);
    expect(round2(2.675)).toBe(2.68);
  });

  it("survives float representation error", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005 * 100) / 100).toBe(1.005);
  });

  it("handles negatives symmetrically", () => {
    expect(round2(-2.675)).toBe(-2.68);
    expect(round2(-10.004)).toBe(-10.0);
  });

  it("passes through integers and zero", () => {
    expect(round2(0)).toBe(0);
    expect(round2(999999)).toBe(999999);
  });
});
```

`2.675` is the classic case: naive `Math.round(2.675 * 100) / 100` gives `2.67` because `2.675` is stored as `2.67499...`. Negative symmetry matters because short positions produce negative P&L legs.

- [ ] **Step 4: Run it and watch it fail**

Run: `pnpm vitest run packages/core/tests/money.test.ts`
Expected: FAIL — cannot resolve `../src/money.js`.

- [ ] **Step 5: Implement `money.ts`**

`packages/core/src/money.ts`:

```ts
/**
 * Round to 2dp using epsilon correction, so 2.675 -> 2.68 rather than 2.67.
 * Every monetary value in QuanTrade passes through here at each computation
 * boundary. Quantities never do — those are integers by construction.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`round2 received a non-finite value: ${value}`);
  }
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) * 100;
  // Nudge by one ulp-ish epsilon to defeat binary representation error.
  const rounded = Math.round(scaled + Number.EPSILON * scaled);
  return (sign * rounded) / 100;
}
```

- [ ] **Step 6: Run the money test**

Run: `pnpm vitest run packages/core/tests/money.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Write `types.ts`**

`packages/core/src/types.ts`:

```ts
export type Market = "NSE" | "US";
export type Currency = "INR" | "USD";
export type Direction = "long" | "short";
export type Side = "buy" | "sell";

export type ExitReason = "stop" | "target" | "max_hold" | "forced";

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "engine_rejected";

export type PositionStatus = "open" | "closed";

/** A daily OHLCV bar. `date` is an ISO date string, `YYYY-MM-DD`, in the
 *  market's local timezone — never a timestamp, to avoid TZ drift. */
export interface Bar {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Book {
  id: string;
  market: Market;
  currency: Currency;
  startingCapital: number;
  cash: number;
}

export interface Proposal {
  id: string;
  bookId: string;
  symbol: string;
  direction: Direction;
  conviction: number;
  stopLoss: number;
  target: number;
  maxHoldSessions: number;
  thesis: string;
  rulesApplied: string[];
  whatWouldFalsifyThis: string;
  status: ProposalStatus;
  engineRejectReason?: string;
}

export interface CostBreakdown {
  brokerage: number;
  stt: number;
  stampDuty: number;
  exchangeFees: number;
  regulatoryFees: number;
  gst: number;
  total: number;
}

export interface Position {
  id: string;
  proposalId: string;
  bookId: string;
  symbol: string;
  sector: string;
  direction: Direction;
  qty: number;
  entryPrice: number;
  entryDate: string;
  stopLoss: number;
  target: number;
  maxHoldSessions: number;
  status: PositionStatus;
  isShadow: boolean;
  entryCosts: number;
  exitPrice?: number;
  exitDate?: string;
  exitReason?: ExitReason;
  exitCosts?: number;
  grossPnl?: number;
  netPnl?: number;
}

export interface EquitySnapshot {
  bookId: string;
  date: string;
  equity: number;
  cash: number;
  deployed: number;
}
```

`entryCosts` and `exitCosts` are stored separately and never folded into `entryPrice`. The spec requires the journal to show gross P&L, costs, and net as three distinct numbers, and burying costs in the fill price makes that impossible to reconstruct later.

- [ ] **Step 8: Write the failing schema test**

`packages/core/tests/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BarSchema, AgentResponseSchema } from "../src/schemas.js";

const validProposal = {
  symbol: "RELIANCE.NS",
  direction: "long",
  conviction: 0.72,
  stop_loss: 2810,
  target: 3120,
  max_hold_sessions: 8,
  thesis: "Reclaimed the 200-day on above-average volume.",
  rules_applied: ["R-004"],
  what_would_falsify_this: "A close back below 2810.",
};

describe("BarSchema", () => {
  it("accepts a coherent bar", () => {
    expect(() =>
      BarSchema.parse({
        symbol: "AAPL", date: "2026-07-27",
        open: 100, high: 105, low: 99, close: 104, volume: 1000,
      }),
    ).not.toThrow();
  });

  it("rejects a high below the open or close", () => {
    expect(() =>
      BarSchema.parse({
        symbol: "AAPL", date: "2026-07-27",
        open: 100, high: 99, low: 98, close: 98.5, volume: 1000,
      }),
    ).toThrow(/high/i);
  });

  it("rejects a low above the open or close", () => {
    expect(() =>
      BarSchema.parse({
        symbol: "AAPL", date: "2026-07-27",
        open: 100, high: 105, low: 101, close: 104, volume: 1000,
      }),
    ).toThrow(/low/i);
  });

  it("rejects negative volume and malformed dates", () => {
    const base = { symbol: "AAPL", open: 100, high: 105, low: 99, close: 104 };
    expect(() => BarSchema.parse({ ...base, date: "2026-07-27", volume: -1 })).toThrow();
    expect(() => BarSchema.parse({ ...base, date: "27-07-2026", volume: 10 })).toThrow();
  });
});

describe("AgentResponseSchema", () => {
  it("accepts a well-formed response", () => {
    const parsed = AgentResponseSchema.parse({
      market_view: "Range-bound, low conviction.",
      proposals: [validProposal],
    });
    expect(parsed.proposals[0]?.symbol).toBe("RELIANCE.NS");
  });

  it("accepts standing aside with no proposals", () => {
    const parsed = AgentResponseSchema.parse({
      market_view: "Nothing worth risking capital on.",
      proposals: [],
      no_trade_reason: "No candidate cleared the volume filter.",
    });
    expect(parsed.proposals).toHaveLength(0);
  });

  it("rejects a proposal missing its stop", () => {
    const { stop_loss, ...noStop } = validProposal;
    expect(() =>
      AgentResponseSchema.parse({ market_view: "x", proposals: [noStop] }),
    ).toThrow();
  });

  it("rejects conviction outside 0..1", () => {
    expect(() =>
      AgentResponseSchema.parse({
        market_view: "x",
        proposals: [{ ...validProposal, conviction: 1.4 }],
      }),
    ).toThrow();
  });

  it("rejects a long whose target sits below its stop", () => {
    expect(() =>
      AgentResponseSchema.parse({
        market_view: "x",
        proposals: [{ ...validProposal, target: 2700 }],
      }),
    ).toThrow(/target/i);
  });

  it("rejects an empty thesis", () => {
    expect(() =>
      AgentResponseSchema.parse({
        market_view: "x",
        proposals: [{ ...validProposal, thesis: "" }],
      }),
    ).toThrow();
  });
});
```

Note there is no `entry_price` and no `qty` anywhere in the agent's schema. The engine decides both. This is the schema-level enforcement of the no-look-ahead and risk-limit rules — the agent is structurally incapable of choosing its own entry or size.

- [ ] **Step 9: Run it and watch it fail**

Run: `pnpm vitest run packages/core/tests/schemas.test.ts`
Expected: FAIL — cannot resolve `../src/schemas.js`.

- [ ] **Step 10: Implement `schemas.ts`**

`packages/core/src/schemas.ts`:

```ts
import { z } from "zod";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const BarSchema = z
  .object({
    symbol: z.string().min(1),
    date: z.string().regex(ISO_DATE, "date must be YYYY-MM-DD"),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    volume: z.number().nonnegative(),
  })
  .superRefine((bar, ctx) => {
    if (bar.high < Math.max(bar.open, bar.close)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "high is below the open or close" });
    }
    if (bar.low > Math.min(bar.open, bar.close)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "low is above the open or close" });
    }
    if (bar.high < bar.low) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "high is below the low" });
    }
  });

export const AgentProposalSchema = z
  .object({
    symbol: z.string().min(1),
    direction: z.enum(["long", "short"]),
    conviction: z.number().min(0).max(1),
    stop_loss: z.number().positive(),
    target: z.number().positive(),
    max_hold_sessions: z.number().int().min(1).max(10),
    thesis: z.string().min(1),
    rules_applied: z.array(z.string()),
    what_would_falsify_this: z.string().min(1),
  })
  .superRefine((p, ctx) => {
    if (p.direction === "long" && p.target <= p.stop_loss) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "long target must sit above the stop" });
    }
    if (p.direction === "short" && p.target >= p.stop_loss) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "short target must sit below the stop" });
    }
  });

export const AgentResponseSchema = z.object({
  market_view: z.string().min(1),
  proposals: z.array(AgentProposalSchema),
  no_trade_reason: z.string().optional(),
});

export type AgentProposal = z.infer<typeof AgentProposalSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
```

- [ ] **Step 11: Write the barrel and typecheck**

`packages/core/src/index.ts`:

```ts
export * from "./types.js";
export * from "./money.js";
export * from "./schemas.js";
```

Run: `pnpm vitest run packages/core` then `pnpm typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 12: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts .gitignore packages/core
git commit -m "feat(core): workspace scaffold, domain types, and validation schemas"
```

---

### Task 2: Market calendars

**Files:**
- Create: `packages/portfolio/package.json`, `packages/portfolio/tsconfig.json`
- Create: `packages/portfolio/src/calendars/nse.json`, `packages/portfolio/src/calendars/us.json`
- Create: `packages/portfolio/src/calendar.ts`
- Test: `packages/portfolio/tests/calendar.test.ts`

**Interfaces:**
- Consumes: `Market` from `@quantrade/core`.
- Produces: `isSessionDay(market, date): boolean`, `nextSessionDay(market, date): string`, `sessionsBetween(market, from, to): string[]`, `addSessions(market, date, n): string`.

A wrong calendar silently shifts every fill date by a day and corrupts the entire ledger without throwing anything. That is why this gets its own task and its own tests before any trading logic exists.

- [ ] **Step 1: Create the portfolio package**

`packages/portfolio/package.json`:

```json
{
  "name": "@quantrade/portfolio",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "@quantrade/core": "workspace:*"
  }
}
```

`packages/portfolio/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

Run: `pnpm install`

- [ ] **Step 2: Add the holiday data**

`packages/portfolio/src/calendars/nse.json` — NSE trading holidays. Include 2026 and 2027; these are published yearly by the exchange and must be reviewed each January.

```json
{
  "market": "NSE",
  "reviewedThrough": "2027-12-31",
  "holidays": [
    "2026-01-26", "2026-03-03", "2026-03-19", "2026-03-21", "2026-04-01",
    "2026-04-03", "2026-04-14", "2026-05-01", "2026-05-27", "2026-08-15",
    "2026-08-26", "2026-09-14", "2026-10-02", "2026-10-21", "2026-11-09",
    "2026-11-24", "2026-12-25"
  ]
}
```

`packages/portfolio/src/calendars/us.json` — NYSE/NASDAQ holidays:

```json
{
  "market": "US",
  "reviewedThrough": "2027-12-31",
  "holidays": [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"
  ]
}
```

These lists are a best-effort starting point. Step 8 adds a guard that makes a stale calendar fail loudly rather than silently, which matters more than the lists being perfect today.

- [ ] **Step 3: Write the failing calendar test**

`packages/portfolio/tests/calendar.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isSessionDay, nextSessionDay, sessionsBetween, addSessions,
} from "../src/calendar.js";

describe("isSessionDay", () => {
  it("accepts an ordinary weekday", () => {
    expect(isSessionDay("NSE", "2026-07-28")).toBe(true);  // Tuesday
    expect(isSessionDay("US", "2026-07-28")).toBe(true);
  });

  it("rejects weekends", () => {
    expect(isSessionDay("NSE", "2026-08-01")).toBe(false); // Saturday
    expect(isSessionDay("NSE", "2026-08-02")).toBe(false); // Sunday
    expect(isSessionDay("US", "2026-08-01")).toBe(false);
  });

  it("rejects each market's own holidays independently", () => {
    // Independence Day: NSE closed, US open.
    expect(isSessionDay("NSE", "2026-08-15")).toBe(false);
    expect(isSessionDay("US", "2026-08-15")).toBe(false); // Saturday anyway
    // Thanksgiving: US closed, NSE open.
    expect(isSessionDay("US", "2026-11-26")).toBe(false);
    expect(isSessionDay("NSE", "2026-11-26")).toBe(true);
    // Republic Day: NSE closed, US open.
    expect(isSessionDay("NSE", "2026-01-26")).toBe(false);
    expect(isSessionDay("US", "2026-01-26")).toBe(true);
  });
});

describe("nextSessionDay", () => {
  it("returns the following weekday", () => {
    expect(nextSessionDay("US", "2026-07-28")).toBe("2026-07-29");
  });

  it("skips the weekend", () => {
    expect(nextSessionDay("US", "2026-07-31")).toBe("2026-08-03"); // Fri -> Mon
  });

  it("skips a holiday that follows a weekend", () => {
    // 2026-11-25 Wed -> 11-26 Thanksgiving -> 11-27 Fri is a session.
    expect(nextSessionDay("US", "2026-11-25")).toBe("2026-11-27");
  });

  it("is strictly forward-looking even from a non-session day", () => {
    expect(nextSessionDay("US", "2026-08-01")).toBe("2026-08-03");
  });
});

describe("sessionsBetween", () => {
  it("returns inclusive session days and excludes closures", () => {
    const days = sessionsBetween("US", "2026-11-23", "2026-11-27");
    expect(days).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"]);
  });

  it("returns an empty list when the range holds no sessions", () => {
    expect(sessionsBetween("US", "2026-08-01", "2026-08-02")).toEqual([]);
  });
});

describe("addSessions", () => {
  it("counts sessions, not calendar days", () => {
    expect(addSessions("US", "2026-07-30", 2)).toBe("2026-08-03"); // Thu +2 -> Mon
  });

  it("returns the same day when adding zero", () => {
    expect(addSessions("US", "2026-07-28", 0)).toBe("2026-07-28");
  });
});

describe("calendar staleness guard", () => {
  it("throws for a date beyond the reviewed horizon", () => {
    expect(() => isSessionDay("US", "2028-03-01")).toThrow(/calendar/i);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `pnpm vitest run packages/portfolio/tests/calendar.test.ts`
Expected: FAIL — cannot resolve `../src/calendar.js`.

- [ ] **Step 5: Implement `calendar.ts`**

`packages/portfolio/src/calendar.ts`:

```ts
import type { Market } from "@quantrade/core";
import nse from "./calendars/nse.json" with { type: "json" };
import us from "./calendars/us.json" with { type: "json" };

interface CalendarFile {
  market: string;
  reviewedThrough: string;
  holidays: string[];
}

const CALENDARS: Record<Market, CalendarFile> = { NSE: nse, US: us };
const HOLIDAYS: Record<Market, Set<string>> = {
  NSE: new Set(nse.holidays),
  US: new Set(us.holidays),
};

/** Parse YYYY-MM-DD as a UTC date. Using UTC throughout keeps the arithmetic
 *  free of DST discontinuities — these are calendar dates, not instants. */
function parse(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Expected a YYYY-MM-DD date, received "${date}"`);
  }
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${date}"`);
  return d;
}

function format(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function assertWithinHorizon(market: Market, date: string): void {
  const horizon = CALENDARS[market].reviewedThrough;
  if (date > horizon) {
    throw new Error(
      `${market} calendar is only reviewed through ${horizon}, but ${date} was requested. ` +
        `Update packages/portfolio/src/calendars/${market.toLowerCase()}.json before trading.`,
    );
  }
}

export function isSessionDay(market: Market, date: string): boolean {
  assertWithinHorizon(market, date);
  const day = parse(date).getUTCDay();
  if (day === 0 || day === 6) return false;
  return !HOLIDAYS[market].has(date);
}

export function nextSessionDay(market: Market, date: string): string {
  const cursor = parse(date);
  for (let i = 0; i < 30; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const candidate = format(cursor);
    if (isSessionDay(market, candidate)) return candidate;
  }
  throw new Error(`No ${market} session found within 30 days of ${date}`);
}

export function sessionsBetween(market: Market, from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = parse(from);
  const end = parse(to);
  while (cursor.getTime() <= end.getTime()) {
    const candidate = format(cursor);
    if (isSessionDay(market, candidate)) out.push(candidate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export function addSessions(market: Market, date: string, n: number): string {
  if (n < 0) throw new Error("addSessions does not walk backwards");
  let cursor = date;
  for (let i = 0; i < n; i++) cursor = nextSessionDay(market, cursor);
  return cursor;
}
```

The staleness guard is the important part. Without it, a 2028 date would quietly be treated as a full session year with no holidays, and every fill date after that point would be wrong with nothing to indicate it.

- [ ] **Step 6: Run the calendar tests**

Run: `pnpm vitest run packages/portfolio/tests/calendar.test.ts`
Expected: PASS, 12 tests.

If a holiday assertion fails, verify the real exchange holiday list and fix the JSON — do not weaken the test to match the data.

- [ ] **Step 7: Commit**

```bash
git add packages/portfolio
git commit -m "feat(portfolio): NSE and US session calendars with a staleness guard"
```

---

### Task 3: Transaction cost model

**Files:**
- Create: `packages/portfolio/src/costs.ts`
- Test: `packages/portfolio/tests/costs.test.ts`

**Interfaces:**
- Consumes: `Market`, `Side`, `CostBreakdown`, `round2` from `@quantrade/core`.
- Produces: `computeCosts(market: Market, side: Side, qty: number, price: number): CostBreakdown`.

**Scope note:** this module covers statutory and broker charges only. Slippage is a *price* effect, not a fee, and is applied in `fills.ts` (Task 5). Keeping them separate means the journal can show "we paid ₹214 in taxes" distinctly from "we filled 0.15% worse than the open", which are different problems with different fixes.

- [ ] **Step 1: Write the failing cost test**

`packages/portfolio/tests/costs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeCosts } from "../src/costs.js";

describe("NSE delivery costs", () => {
  // Turnover: 100 shares x 1000 = 100,000 INR
  it("charges STT, stamp duty, exchange, SEBI and GST on a buy", () => {
    const c = computeCosts("NSE", "buy", 100, 1000);
    expect(c.brokerage).toBe(0);
    expect(c.stt).toBe(100);        // 0.1% of 100,000
    expect(c.stampDuty).toBe(15);   // 0.015% of 100,000
    expect(c.exchangeFees).toBe(2.97);   // 0.00297%
    expect(c.regulatoryFees).toBe(0.1);  // 0.0001%
    expect(c.gst).toBe(0.55);       // 18% of (0 + 2.97 + 0.1) = 0.5526 -> 0.55
    expect(c.total).toBe(118.62);
  });

  it("charges STT but no stamp duty on a sell", () => {
    const c = computeCosts("NSE", "sell", 100, 1000);
    expect(c.stt).toBe(100);
    expect(c.stampDuty).toBe(0);
    expect(c.total).toBe(103.62);
  });

  it("keeps a round trip near 0.22% before slippage", () => {
    const buy = computeCosts("NSE", "buy", 100, 1000);
    const sell = computeCosts("NSE", "sell", 100, 1000);
    const roundTripPct = ((buy.total + sell.total) / 100_000) * 100;
    expect(roundTripPct).toBeGreaterThan(0.2);
    expect(roundTripPct).toBeLessThan(0.25);
  });
});

describe("US costs", () => {
  // Turnover: 100 shares x 200 = 20,000 USD
  it("charges nothing on a buy", () => {
    const c = computeCosts("US", "buy", 100, 200);
    expect(c.total).toBe(0);
  });

  it("charges SEC and TAF fees on a sell", () => {
    const c = computeCosts("US", "sell", 100, 200);
    expect(c.regulatoryFees).toBe(0.56); // 0.00278% of 20,000 = 0.556 + TAF 0.0166 -> 0.5726 -> 0.57
    expect(c.total).toBeGreaterThan(0);
    expect(c.total).toBeLessThan(1);
  });

  it("caps the TAF at 8.30 on very large sells", () => {
    const c = computeCosts("US", "sell", 1_000_000, 50);
    // TAF would be 166.00 uncapped; capped at 8.30.
    // SEC = 0.00278% of 50,000,000 = 1390.00
    expect(c.regulatoryFees).toBe(1398.3);
  });
});

describe("input validation", () => {
  it("rejects a non-integer or negative quantity", () => {
    expect(() => computeCosts("NSE", "buy", 10.5, 100)).toThrow(/quantity/i);
    expect(() => computeCosts("NSE", "buy", -1, 100)).toThrow(/quantity/i);
  });

  it("rejects a non-positive price", () => {
    expect(() => computeCosts("NSE", "buy", 10, 0)).toThrow(/price/i);
  });
});
```

The round-trip assertion is the one that matters long-term. Individual rates change when regulators adjust them; the aggregate staying near 0.22% is the invariant worth pinning, and a failure there means someone changed a rate meaningfully rather than cosmetically.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/portfolio/tests/costs.test.ts`
Expected: FAIL — cannot resolve `../src/costs.js`.

- [ ] **Step 3: Implement `costs.ts`**

`packages/portfolio/src/costs.ts`:

```ts
import { round2, type CostBreakdown, type Market, type Side } from "@quantrade/core";

/** Statutory rates as fractions of turnover. Reviewed against the exchange
 *  and regulator schedules; see docs/specs for the source table. */
const NSE = {
  brokerage: 0,        // discount broker, delivery segment
  stt: 0.001,          // 0.1%, both sides for delivery
  stampDuty: 0.00015,  // 0.015%, buy side only
  exchange: 0.0000297, // 0.00297%
  sebi: 0.000001,      // 0.0001%
  gst: 0.18,           // on brokerage + exchange + sebi
} as const;

const US = {
  sec: 0.0000278,      // 0.00278%, sell side only
  tafPerShare: 0.000166,
  tafCap: 8.3,
} as const;

const ZERO: CostBreakdown = {
  brokerage: 0, stt: 0, stampDuty: 0,
  exchangeFees: 0, regulatoryFees: 0, gst: 0, total: 0,
};

export function computeCosts(
  market: Market,
  side: Side,
  qty: number,
  price: number,
): CostBreakdown {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`Quantity must be a positive integer, received ${qty}`);
  }
  if (!(price > 0)) {
    throw new Error(`Price must be positive, received ${price}`);
  }

  const turnover = qty * price;

  if (market === "NSE") {
    const brokerage = round2(turnover * NSE.brokerage);
    const stt = round2(turnover * NSE.stt);
    const stampDuty = side === "buy" ? round2(turnover * NSE.stampDuty) : 0;
    const exchangeFees = round2(turnover * NSE.exchange);
    const regulatoryFees = round2(turnover * NSE.sebi);
    const gst = round2((brokerage + exchangeFees + regulatoryFees) * NSE.gst);
    return {
      brokerage, stt, stampDuty, exchangeFees, regulatoryFees, gst,
      total: round2(brokerage + stt + stampDuty + exchangeFees + regulatoryFees + gst),
    };
  }

  // US: buying is free; selling carries SEC and FINRA TAF.
  if (side === "buy") return { ...ZERO };

  const sec = turnover * US.sec;
  const taf = Math.min(qty * US.tafPerShare, US.tafCap);
  const regulatoryFees = round2(sec + taf);
  return { ...ZERO, regulatoryFees, total: regulatoryFees };
}
```

- [ ] **Step 4: Run the cost tests**

Run: `pnpm vitest run packages/portfolio/tests/costs.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/portfolio/src/costs.ts packages/portfolio/tests/costs.test.ts
git commit -m "feat(portfolio): per-market transaction cost model"
```

---

### Task 4: Position sizing and risk limits

**Files:**
- Create: `packages/portfolio/src/sizing.ts`
- Test: `packages/portfolio/tests/sizing.test.ts`

**Interfaces:**
- Consumes: `Position`, `Proposal`, `Market`, `Direction` from `@quantrade/core`.
- Produces:
  - `sizePosition(input: SizingInput): SizingResult`
  - `type SizingInput = { equity: number; entryPrice: number; stopLoss: number; direction: Direction }`
  - `type SizingResult = { qty: number; riskAmount: number; notional: number }`
  - `validateProposal(input: ValidationInput): { ok: true } | { ok: false; reason: string }`
  - `type ValidationInput = { market: Market; symbol: string; direction: Direction; entryPrice: number; stopLoss: number; target: number; sector: string; equity: number; cash: number; openPositions: Position[] }`

`sizePosition` answers "how many shares"; `validateProposal` answers "may we take this at all". They are separate because a proposal can be perfectly sized and still be forbidden by an exposure cap, and the rejection reasons feed back into the agent's context differently.

- [ ] **Step 1: Write the failing sizing test**

`packages/portfolio/tests/sizing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sizePosition, validateProposal } from "../src/sizing.js";
import type { Position } from "@quantrade/core";

const EQUITY = 1_000_000;

function openPosition(over: Partial<Position> = {}): Position {
  return {
    id: "p1", proposalId: "pr1", bookId: "b1",
    symbol: "AAA", sector: "IT", direction: "long",
    qty: 10, entryPrice: 100, entryDate: "2026-07-01",
    stopLoss: 90, target: 130, maxHoldSessions: 10,
    status: "open", isShadow: false, entryCosts: 0,
    ...over,
  };
}

describe("sizePosition", () => {
  it("derives quantity from the stop distance at 2% risk", () => {
    // Risk budget 20,000; stop distance 50 -> 400 shares.
    // Notional 400 x 1000 = 400,000, which breaches the 5% cap (50,000),
    // so it is capped to 50 shares.
    const r = sizePosition({ equity: EQUITY, entryPrice: 1000, stopLoss: 950, direction: "long" });
    expect(r.qty).toBe(50);
    expect(r.notional).toBe(50_000);
  });

  it("lets the risk budget bind when the stop is wide", () => {
    // Risk budget 20,000; stop distance 500 -> 40 shares.
    // Notional 40 x 1000 = 40,000, under the 50,000 cap, so risk binds.
    const r = sizePosition({ equity: EQUITY, entryPrice: 1000, stopLoss: 500, direction: "long" });
    expect(r.qty).toBe(40);
    expect(r.riskAmount).toBe(20_000);
  });

  it("rounds quantity down, never up", () => {
    // Risk budget 20,000; stop distance 300 -> 66.67 -> 66 shares.
    const r = sizePosition({ equity: EQUITY, entryPrice: 700, stopLoss: 400, direction: "long" });
    expect(r.qty).toBe(66);
  });

  it("sizes shorts off the same absolute stop distance", () => {
    const r = sizePosition({ equity: EQUITY, entryPrice: 1000, stopLoss: 1050, direction: "short" });
    expect(r.qty).toBe(50); // 5% cap binds, same as the mirrored long
  });

  it("returns zero when a tight stop cannot buy a single share", () => {
    const r = sizePosition({ equity: 1000, entryPrice: 5000, stopLoss: 4999, direction: "long" });
    expect(r.qty).toBe(0);
  });

  it("throws when the stop sits on the entry", () => {
    expect(() =>
      sizePosition({ equity: EQUITY, entryPrice: 1000, stopLoss: 1000, direction: "long" }),
    ).toThrow(/stop/i);
  });
});

describe("validateProposal", () => {
  const base = {
    market: "US" as const, symbol: "TGT", direction: "long" as const,
    entryPrice: 100, stopLoss: 90, target: 130,
    sector: "IT", equity: EQUITY, cash: EQUITY, openPositions: [] as Position[],
  };

  it("accepts a compliant proposal", () => {
    expect(validateProposal(base)).toEqual({ ok: true });
  });

  it("rejects an NSE short outright", () => {
    const r = validateProposal({ ...base, market: "NSE", direction: "short", stopLoss: 110, target: 80 });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/short/i) });
  });

  it("rejects a long whose stop sits above the entry", () => {
    const r = validateProposal({ ...base, stopLoss: 110 });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/stop/i) });
  });

  it("rejects a ninth open position", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      openPosition({ id: `p${i}`, symbol: `S${i}`, sector: `SEC${i}` }),
    );
    const r = validateProposal({ ...base, openPositions: eight });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/8 open positions/i) });
  });

  it("rejects a second position in a symbol already held", () => {
    const r = validateProposal({
      ...base,
      openPositions: [openPosition({ symbol: "TGT", sector: "ENERGY" })],
    });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/already holds TGT/i) });
  });

  it("allows a different symbol in a sector that has room", () => {
    const r = validateProposal({
      ...base,
      openPositions: [openPosition({ symbol: "OTHER", sector: "ENERGY" })],
    });
    expect(r).toEqual({ ok: true });
  });

  it("rejects a breach of the 25% sector cap", () => {
    // Existing IT exposure: 2400 x 100 = 240,000 (24%). A new 5% IT position
    // takes it to 29%.
    const heavy = openPosition({ qty: 2400, entryPrice: 100, sector: "IT" });
    const r = validateProposal({ ...base, openPositions: [heavy] });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/sector/i) });
  });

  it("rejects a breach of the 60% deployed cap", () => {
    const heavy = openPosition({ qty: 5900, entryPrice: 100, sector: "ENERGY" });
    const r = validateProposal({ ...base, openPositions: [heavy] });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/deployed/i) });
  });

  it("rejects when cash cannot cover the notional", () => {
    const r = validateProposal({ ...base, cash: 100 });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/cash/i) });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/portfolio/tests/sizing.test.ts`
Expected: FAIL — cannot resolve `../src/sizing.js`.

- [ ] **Step 3: Implement `sizing.ts`**

`packages/portfolio/src/sizing.ts`:

```ts
import { round2, type Direction, type Market, type Position } from "@quantrade/core";

export const RISK_PER_TRADE = 0.02;   // 2% of equity
export const MAX_POSITION_PCT = 0.05; // 5% of equity
export const MAX_SECTOR_PCT = 0.25;
export const MAX_DEPLOYED_PCT = 0.6;
export const MAX_OPEN_POSITIONS = 8;

export interface SizingInput {
  equity: number;
  entryPrice: number;
  stopLoss: number;
  direction: Direction;
}

export interface SizingResult {
  qty: number;
  riskAmount: number;
  notional: number;
}

export function sizePosition({ equity, entryPrice, stopLoss, direction }: SizingInput): SizingResult {
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance === 0) {
    throw new Error("Stop loss cannot equal the entry price — risk would be undefined");
  }
  void direction; // absolute distance covers both sides

  const riskBudget = equity * RISK_PER_TRADE;
  const byRisk = Math.floor(riskBudget / stopDistance);
  const byNotional = Math.floor((equity * MAX_POSITION_PCT) / entryPrice);
  const qty = Math.max(0, Math.min(byRisk, byNotional));

  return {
    qty,
    riskAmount: round2(qty * stopDistance),
    notional: round2(qty * entryPrice),
  };
}

export interface ValidationInput {
  market: Market;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  target: number;
  sector: string;
  equity: number;
  cash: number;
  openPositions: Position[];
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateProposal(input: ValidationInput): ValidationResult {
  const { market, symbol, direction, entryPrice, stopLoss, target, sector, equity, cash, openPositions } = input;

  if (market === "NSE" && direction === "short") {
    return { ok: false, reason: "NSE delivery does not permit short positions" };
  }

  if (openPositions.some((p) => p.symbol === symbol)) {
    return { ok: false, reason: `Book already holds ${symbol}` };
  }

  if (direction === "long" && !(stopLoss < entryPrice)) {
    return { ok: false, reason: "A long stop must sit below the entry price" };
  }
  if (direction === "short" && !(stopLoss > entryPrice)) {
    return { ok: false, reason: "A short stop must sit above the entry price" };
  }
  if (direction === "long" && !(target > entryPrice)) {
    return { ok: false, reason: "A long target must sit above the entry price" };
  }
  if (direction === "short" && !(target < entryPrice)) {
    return { ok: false, reason: "A short target must sit below the entry price" };
  }

  if (openPositions.length >= MAX_OPEN_POSITIONS) {
    return { ok: false, reason: `Book already holds ${MAX_OPEN_POSITIONS} open positions` };
  }

  const { qty, notional } = sizePosition({ equity, entryPrice, stopLoss, direction });
  if (qty === 0) {
    return { ok: false, reason: "Risk budget does not support a single share at this stop distance" };
  }

  const valueOf = (p: Position) => p.qty * p.entryPrice;
  const deployed = openPositions.reduce((sum, p) => sum + valueOf(p), 0);
  const sectorExposure = openPositions
    .filter((p) => p.sector === sector)
    .reduce((sum, p) => sum + valueOf(p), 0);

  if (sectorExposure + notional > equity * MAX_SECTOR_PCT) {
    return {
      ok: false,
      reason: `Sector ${sector} exposure would exceed ${MAX_SECTOR_PCT * 100}% of equity`,
    };
  }
  if (deployed + notional > equity * MAX_DEPLOYED_PCT) {
    return { ok: false, reason: `Deployed capital would exceed ${MAX_DEPLOYED_PCT * 100}% of equity` };
  }
  if (notional > cash) {
    return { ok: false, reason: "Insufficient cash to cover the position notional" };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run the sizing tests**

Run: `pnpm vitest run packages/portfolio/tests/sizing.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/portfolio/src/sizing.ts packages/portfolio/tests/sizing.test.ts
git commit -m "feat(portfolio): risk-derived position sizing and proposal validation"
```

---

### Task 5: Fill resolution

**Files:**
- Create: `packages/portfolio/src/fills.ts`
- Test: `packages/portfolio/tests/fills.test.ts`

**Interfaces:**
- Consumes: `Bar`, `Direction`, `ExitReason`, `Side`, `round2` from `@quantrade/core`.
- Produces:
  - `SLIPPAGE_RATE` (0.0015)
  - `applySlippage(price: number, side: Side): number`
  - `resolveEntry(bar: Bar, direction: Direction): number`
  - `resolveExit(bar: Bar, pos: ExitCheck): { price: number; reason: ExitReason } | null`
  - `type ExitCheck = { direction: Direction; stopLoss: number; target: number }`

This is the module that decides whether the whole project's numbers are honest. Every rule in it costs the strategy money on purpose.

- [ ] **Step 1: Write the failing fills test**

`packages/portfolio/tests/fills.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applySlippage, resolveEntry, resolveExit, SLIPPAGE_RATE } from "../src/fills.js";
import type { Bar } from "@quantrade/core";

function bar(over: Partial<Bar> = {}): Bar {
  return {
    symbol: "AAA", date: "2026-07-28",
    open: 100, high: 105, low: 95, close: 102, volume: 1000,
    ...over,
  };
}

describe("applySlippage", () => {
  it("always moves the price against us", () => {
    expect(applySlippage(100, "buy")).toBe(100.15);
    expect(applySlippage(100, "sell")).toBe(99.85);
  });

  it("uses the documented 0.15% rate", () => {
    expect(SLIPPAGE_RATE).toBe(0.0015);
  });
});

describe("resolveEntry", () => {
  it("fills a long at the open plus slippage", () => {
    expect(resolveEntry(bar({ open: 200 }), "long")).toBe(200.3);
  });

  it("fills a short at the open minus slippage", () => {
    expect(resolveEntry(bar({ open: 200 }), "short")).toBe(199.7);
  });
});

describe("resolveExit — long positions", () => {
  const pos = { direction: "long" as const, stopLoss: 90, target: 120 };

  it("returns null when neither level is touched", () => {
    expect(resolveExit(bar({ open: 100, high: 110, low: 95, close: 105 }), pos)).toBeNull();
  });

  it("exits at the stop when the low touches it", () => {
    const r = resolveExit(bar({ open: 100, high: 105, low: 89, close: 95 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(90, "sell"));
  });

  it("exits at the target when the high touches it", () => {
    const r = resolveExit(bar({ open: 100, high: 121, low: 99, close: 119 }), pos);
    expect(r?.reason).toBe("target");
    expect(r?.price).toBe(applySlippage(120, "sell"));
  });

  it("gives the stop priority when both are touched in one session", () => {
    const r = resolveExit(bar({ open: 100, high: 125, low: 88, close: 110 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(90, "sell"));
  });

  it("fills at the open, not the stop, when the session gaps below it", () => {
    const r = resolveExit(bar({ open: 80, high: 85, low: 78, close: 82 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(80, "sell")); // 80, not 90
  });

  it("fills at the open when the session gaps above the target", () => {
    const r = resolveExit(bar({ open: 130, high: 135, low: 128, close: 133 }), pos);
    expect(r?.reason).toBe("target");
    expect(r?.price).toBe(applySlippage(130, "sell"));
  });

  it("prefers the stop when the session gaps below it and later reaches the target", () => {
    const r = resolveExit(bar({ open: 80, high: 125, low: 79, close: 120 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(80, "sell"));
  });
});

describe("resolveExit — short positions", () => {
  const pos = { direction: "short" as const, stopLoss: 120, target: 90 };

  it("exits at the stop when the high touches it", () => {
    const r = resolveExit(bar({ open: 110, high: 121, low: 105, close: 118 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(120, "buy"));
  });

  it("exits at the target when the low touches it", () => {
    const r = resolveExit(bar({ open: 110, high: 112, low: 89, close: 92 }), pos);
    expect(r?.reason).toBe("target");
    expect(r?.price).toBe(applySlippage(90, "buy"));
  });

  it("gives the stop priority when both are touched", () => {
    const r = resolveExit(bar({ open: 110, high: 125, low: 85, close: 100 }), pos);
    expect(r?.reason).toBe("stop");
  });

  it("fills at the open when the session gaps above the stop", () => {
    const r = resolveExit(bar({ open: 140, high: 145, low: 138, close: 142 }), pos);
    expect(r?.reason).toBe("stop");
    expect(r?.price).toBe(applySlippage(140, "buy"));
  });
});
```

The gap-and-recover case matters most. A session that opens at 80, dips to 79, then rallies to 125 looks like a winner if you evaluate the target first — but you were stopped out at the open and were never in the trade for the rally. Getting this backwards is how a losing strategy shows a profit.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/portfolio/tests/fills.test.ts`
Expected: FAIL — cannot resolve `../src/fills.js`.

- [ ] **Step 3: Implement `fills.ts`**

`packages/portfolio/src/fills.ts`:

```ts
import { round2, type Bar, type Direction, type ExitReason, type Side } from "@quantrade/core";

/** 0.15% each way, both markets. See spec section 5.2. */
export const SLIPPAGE_RATE = 0.0015;

/** Slippage always moves against the trader: buys fill higher, sells lower. */
export function applySlippage(price: number, side: Side): number {
  const factor = side === "buy" ? 1 + SLIPPAGE_RATE : 1 - SLIPPAGE_RATE;
  return round2(price * factor);
}

/** Entries always fill at the session open. The caller is responsible for
 *  passing the *next* session's bar — never the bar the decision came from. */
export function resolveEntry(bar: Bar, direction: Direction): number {
  return applySlippage(bar.open, direction === "long" ? "buy" : "sell");
}

export interface ExitCheck {
  direction: Direction;
  stopLoss: number;
  target: number;
}

export interface ExitFill {
  price: number;
  reason: ExitReason;
}

/**
 * Resolve whether a session closes a position, and at what price.
 *
 * Evaluation order is deliberate and conservative:
 *   1. Gap through the stop  -> fill at the open (stops do not protect gaps)
 *   2. Stop touched          -> fill at the stop (wins any same-session tie)
 *   3. Gap through the target-> fill at the open
 *   4. Target touched        -> fill at the target
 *
 * Daily bars cannot tell us whether the high or the low came first, so the
 * unfavourable assumption is the only defensible one.
 */
export function resolveExit(bar: Bar, pos: ExitCheck): ExitFill | null {
  const exitSide: Side = pos.direction === "long" ? "sell" : "buy";
  const fill = (price: number, reason: ExitReason): ExitFill => ({
    price: applySlippage(price, exitSide),
    reason,
  });

  if (pos.direction === "long") {
    if (bar.open <= pos.stopLoss) return fill(bar.open, "stop");
    if (bar.low <= pos.stopLoss) return fill(pos.stopLoss, "stop");
    if (bar.open >= pos.target) return fill(bar.open, "target");
    if (bar.high >= pos.target) return fill(pos.target, "target");
    return null;
  }

  if (bar.open >= pos.stopLoss) return fill(bar.open, "stop");
  if (bar.high >= pos.stopLoss) return fill(pos.stopLoss, "stop");
  if (bar.open <= pos.target) return fill(bar.open, "target");
  if (bar.low <= pos.target) return fill(pos.target, "target");
  return null;
}
```

- [ ] **Step 4: Run the fills tests**

Run: `pnpm vitest run packages/portfolio/tests/fills.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/portfolio/src/fills.ts packages/portfolio/tests/fills.test.ts
git commit -m "feat(portfolio): conservative fill resolution with gap and tie-break handling"
```

---

### Task 6: The settle engine

**Files:**
- Create: `packages/portfolio/src/engine.ts`, `packages/portfolio/src/index.ts`
- Test: `packages/portfolio/tests/engine.test.ts`

**Interfaces:**
- Consumes: `computeCosts`, `sizePosition`, `validateProposal`, `resolveEntry`, `resolveExit`, `addSessions`, `isSessionDay`, and the `@quantrade/core` types.
- Produces:
  - `settle(input: SettleInput): SettleResult`
  - `type SettleInput = { book: Book; date: string; openPositions: Position[]; pendingEntries: PendingEntry[]; bars: Record<string, Bar>; sectors: Record<string, string> }`
  - `type PendingEntry = { proposal: Proposal; sector: string }`
  - `type SettleResult = { book: Book; opened: Position[]; closed: Position[]; stillOpen: Position[]; rejected: Array<{ proposalId: string; reason: string }>; snapshot: EquitySnapshot }`

`settle` is the only stateful-looking function in the package, and it still isn't stateful — it takes the world as an argument and returns a new world. `date` is always passed in; the engine never reads a clock.

- [ ] **Step 1: Write the failing engine test**

`packages/portfolio/tests/engine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { settle } from "../src/engine.js";
import { applySlippage } from "../src/fills.js";
import { computeCosts } from "../src/costs.js";
import type { Bar, Book, Position, Proposal } from "@quantrade/core";

const book: Book = {
  id: "b-us", market: "US", currency: "USD",
  startingCapital: 999_999, cash: 999_999,
};

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "pr-1", bookId: "b-us", symbol: "AAA", direction: "long",
    conviction: 0.7, stopLoss: 90, target: 130, maxHoldSessions: 5,
    thesis: "t", rulesApplied: [], whatWouldFalsifyThis: "f",
    status: "approved",
    ...over,
  };
}

function bar(over: Partial<Bar> = {}): Bar {
  return {
    symbol: "AAA", date: "2026-07-28",
    open: 100, high: 104, low: 98, close: 103, volume: 5000,
    ...over,
  };
}

describe("settle — opening positions", () => {
  it("opens an approved proposal at the session open plus slippage", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [], pendingEntries: [{ proposal: proposal(), sector: "IT" }],
      bars: { AAA: bar() }, sectors: { AAA: "IT" },
    });

    expect(r.opened).toHaveLength(1);
    const p = r.opened[0]!;
    expect(p.entryPrice).toBe(applySlippage(100, "buy"));
    expect(p.entryDate).toBe("2026-07-28");
    expect(p.qty).toBeGreaterThan(0);
    expect(p.status).toBe("open");
  });

  it("debits cash by notional plus entry costs", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [], pendingEntries: [{ proposal: proposal(), sector: "IT" }],
      bars: { AAA: bar() }, sectors: { AAA: "IT" },
    });
    const p = r.opened[0]!;
    const expected = 999_999 - (p.qty * p.entryPrice) - p.entryCosts;
    expect(r.book.cash).toBeCloseTo(expected, 2);
  });

  it("records an engine rejection instead of opening when a limit is breached", () => {
    const r = settle({
      book: { ...book, market: "NSE", id: "b-nse", currency: "INR" },
      date: "2026-07-28",
      openPositions: [],
      pendingEntries: [{ proposal: proposal({ direction: "short", stopLoss: 130, target: 80 }), sector: "IT" }],
      bars: { AAA: bar() }, sectors: { AAA: "IT" },
    });
    expect(r.opened).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/short/i);
  });

  it("rejects a proposal whose bar is missing rather than guessing a price", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [], pendingEntries: [{ proposal: proposal(), sector: "IT" }],
      bars: {}, sectors: { AAA: "IT" },
    });
    expect(r.opened).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/no bar/i);
  });
});

describe("settle — closing positions", () => {
  function held(over: Partial<Position> = {}): Position {
    return {
      id: "pos-1", proposalId: "pr-1", bookId: "b-us",
      symbol: "AAA", sector: "IT", direction: "long",
      qty: 100, entryPrice: 100, entryDate: "2026-07-20",
      stopLoss: 90, target: 130, maxHoldSessions: 5,
      status: "open", isShadow: false, entryCosts: 0,
      ...over,
    };
  }

  it("closes at the stop and computes gross, costs and net separately", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [held()], pendingEntries: [],
      bars: { AAA: bar({ open: 95, high: 96, low: 88, close: 89 }) },
      sectors: { AAA: "IT" },
    });

    const c = r.closed[0]!;
    const exitPrice = applySlippage(90, "sell");
    expect(c.exitReason).toBe("stop");
    expect(c.exitPrice).toBe(exitPrice);
    expect(c.grossPnl).toBeCloseTo((exitPrice - 100) * 100, 2);
    expect(c.exitCosts).toBe(computeCosts("US", "sell", 100, exitPrice).total);
    expect(c.netPnl).toBeCloseTo(c.grossPnl! - c.entryCosts - c.exitCosts!, 2);
    expect(c.status).toBe("closed");
  });

  it("credits cash by exit proceeds less exit costs", () => {
    const r = settle({
      book: { ...book, cash: 500_000 }, date: "2026-07-28",
      openPositions: [held()], pendingEntries: [],
      bars: { AAA: bar({ open: 125, high: 131, low: 124, close: 130 }) },
      sectors: { AAA: "IT" },
    });
    const c = r.closed[0]!;
    const proceeds = c.qty * c.exitPrice! - c.exitCosts!;
    expect(r.book.cash).toBeCloseTo(500_000 + proceeds, 2);
  });

  it("force-closes at the open once max hold sessions elapse", () => {
    // Entered 2026-07-20; 5 sessions later is 2026-07-27, so 07-28 is overdue.
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [held({ entryDate: "2026-07-20", maxHoldSessions: 5 })],
      pendingEntries: [],
      bars: { AAA: bar({ open: 101, high: 104, low: 99, close: 103 }) },
      sectors: { AAA: "IT" },
    });
    expect(r.closed[0]?.exitReason).toBe("max_hold");
    expect(r.closed[0]?.exitPrice).toBe(applySlippage(101, "sell"));
  });

  it("lets the stop win over max hold on the same session", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [held({ entryDate: "2026-07-20", maxHoldSessions: 5 })],
      pendingEntries: [],
      bars: { AAA: bar({ open: 95, high: 96, low: 85, close: 87 }) },
      sectors: { AAA: "IT" },
    });
    expect(r.closed[0]?.exitReason).toBe("stop");
  });

  it("holds a position that touches neither level", () => {
    const r = settle({
      book, date: "2026-07-28",
      openPositions: [held({ entryDate: "2026-07-27" })], pendingEntries: [],
      bars: { AAA: bar({ open: 100, high: 105, low: 96, close: 104 }) },
      sectors: { AAA: "IT" },
    });
    expect(r.closed).toHaveLength(0);
    expect(r.stillOpen).toHaveLength(1);
  });
});

describe("settle — equity snapshot", () => {
  it("marks open positions to the close and reports cash and deployed", () => {
    const p: Position = {
      id: "pos-1", proposalId: "pr-1", bookId: "b-us",
      symbol: "AAA", sector: "IT", direction: "long",
      qty: 100, entryPrice: 100, entryDate: "2026-07-27",
      stopLoss: 90, target: 130, maxHoldSessions: 5,
      status: "open", isShadow: false, entryCosts: 0,
    };
    const r = settle({
      book: { ...book, cash: 100_000 }, date: "2026-07-28",
      openPositions: [p], pendingEntries: [],
      bars: { AAA: bar({ open: 100, high: 106, low: 99, close: 105 }) },
      sectors: { AAA: "IT" },
    });
    expect(r.snapshot.deployed).toBe(10_500); // 100 x 105 close
    expect(r.snapshot.cash).toBe(100_000);
    expect(r.snapshot.equity).toBe(110_500);
    expect(r.snapshot.date).toBe("2026-07-28");
  });

  it("values a short position inversely", () => {
    const p: Position = {
      id: "pos-2", proposalId: "pr-2", bookId: "b-us",
      symbol: "AAA", sector: "IT", direction: "short",
      qty: 100, entryPrice: 100, entryDate: "2026-07-27",
      stopLoss: 120, target: 80, maxHoldSessions: 5,
      status: "open", isShadow: false, entryCosts: 0,
    };
    const r = settle({
      book: { ...book, cash: 100_000 }, date: "2026-07-28",
      openPositions: [p], pendingEntries: [],
      bars: { AAA: bar({ open: 100, high: 101, low: 94, close: 95 }) },
      sectors: { AAA: "IT" },
    });
    // Short at 100, marked at 95 -> 500 unrealised gain on top of the 10,000 margin value.
    expect(r.snapshot.deployed).toBe(10_500);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/portfolio/tests/engine.test.ts`
Expected: FAIL — cannot resolve `../src/engine.js`.

- [ ] **Step 3: Implement `engine.ts`**

`packages/portfolio/src/engine.ts`:

```ts
import {
  round2,
  type Bar, type Book, type EquitySnapshot, type Position, type Proposal,
} from "@quantrade/core";
import { addSessions } from "./calendar.js";
import { computeCosts } from "./costs.js";
import { resolveEntry, resolveExit, applySlippage } from "./fills.js";
import { sizePosition, validateProposal } from "./sizing.js";

export interface PendingEntry {
  proposal: Proposal;
  sector: string;
}

export interface SettleInput {
  book: Book;
  date: string;
  openPositions: Position[];
  pendingEntries: PendingEntry[];
  /** Bars for `date`, keyed by symbol. A missing symbol is a rejection, not a guess. */
  bars: Record<string, Bar>;
  sectors: Record<string, string>;
}

export interface SettleResult {
  book: Book;
  opened: Position[];
  closed: Position[];
  stillOpen: Position[];
  rejected: Array<{ proposalId: string; reason: string }>;
  snapshot: EquitySnapshot;
}

/** Mark-to-market value of a position at a given price. */
function markValue(pos: Position, price: number): number {
  const base = pos.qty * pos.entryPrice;
  const move = (price - pos.entryPrice) * pos.qty;
  return round2(pos.direction === "long" ? base + move : base - move);
}

export function settle(input: SettleInput): SettleResult {
  const { book, date, bars, sectors } = input;
  let cash = book.cash;

  const closed: Position[] = [];
  const stillOpen: Position[] = [];
  const opened: Position[] = [];
  const rejected: Array<{ proposalId: string; reason: string }> = [];

  // --- 1. Resolve exits on existing positions, before any new entry. ---
  for (const pos of input.openPositions) {
    const bar = bars[pos.symbol];
    if (!bar) {
      // No data for today: carry the position rather than inventing a price.
      stillOpen.push(pos);
      continue;
    }

    let exit = resolveExit(bar, pos);

    if (!exit) {
      const dueDate = addSessions(book.market, pos.entryDate, pos.maxHoldSessions);
      if (date >= dueDate) {
        const side = pos.direction === "long" ? "sell" : "buy";
        exit = { price: applySlippage(bar.open, side), reason: "max_hold" };
      }
    }

    if (!exit) {
      stillOpen.push(pos);
      continue;
    }

    const exitCosts = computeCosts(
      book.market,
      pos.direction === "long" ? "sell" : "buy",
      pos.qty,
      exit.price,
    ).total;

    const grossPnl = round2(
      pos.direction === "long"
        ? (exit.price - pos.entryPrice) * pos.qty
        : (pos.entryPrice - exit.price) * pos.qty,
    );
    const netPnl = round2(grossPnl - pos.entryCosts - exitCosts);

    if (!pos.isShadow) {
      cash = round2(cash + pos.qty * exit.price - exitCosts);
    }

    closed.push({
      ...pos,
      status: "closed",
      exitPrice: exit.price,
      exitDate: date,
      exitReason: exit.reason,
      exitCosts,
      grossPnl,
      netPnl,
    });
  }

  // --- 2. Open approved proposals at today's open. ---
  const equityForSizing = book.startingCapital;
  for (const { proposal, sector } of input.pendingEntries) {
    const bar = bars[proposal.symbol];
    if (!bar) {
      rejected.push({ proposalId: proposal.id, reason: `No bar for ${proposal.symbol} on ${date}` });
      continue;
    }

    const entryPrice = resolveEntry(bar, proposal.direction);
    const verdict = validateProposal({
      market: book.market,
      symbol: proposal.symbol,
      direction: proposal.direction,
      entryPrice,
      stopLoss: proposal.stopLoss,
      target: proposal.target,
      sector,
      equity: equityForSizing,
      cash,
      openPositions: stillOpen,
    });

    if (!verdict.ok) {
      rejected.push({ proposalId: proposal.id, reason: verdict.reason });
      continue;
    }

    const { qty } = sizePosition({
      equity: equityForSizing,
      entryPrice,
      stopLoss: proposal.stopLoss,
      direction: proposal.direction,
    });

    const entryCosts = computeCosts(
      book.market,
      proposal.direction === "long" ? "buy" : "sell",
      qty,
      entryPrice,
    ).total;

    const position: Position = {
      id: `${proposal.id}-pos`,
      proposalId: proposal.id,
      bookId: book.id,
      symbol: proposal.symbol,
      sector: sectors[proposal.symbol] ?? sector,
      direction: proposal.direction,
      qty,
      entryPrice,
      entryDate: date,
      stopLoss: proposal.stopLoss,
      target: proposal.target,
      maxHoldSessions: proposal.maxHoldSessions,
      status: "open",
      isShadow: proposal.status === "rejected" || proposal.status === "expired",
      entryCosts,
    };

    if (!position.isShadow) {
      cash = round2(cash - qty * entryPrice - entryCosts);
    }

    opened.push(position);
    stillOpen.push(position);
  }

  // --- 3. Mark the book to today's closes. ---
  const deployed = round2(
    stillOpen
      .filter((p) => !p.isShadow)
      .reduce((sum, p) => {
        const bar = bars[p.symbol];
        return sum + markValue(p, bar ? bar.close : p.entryPrice);
      }, 0),
  );

  const snapshot: EquitySnapshot = {
    bookId: book.id,
    date,
    cash: round2(cash),
    deployed,
    equity: round2(cash + deployed),
  };

  return {
    book: { ...book, cash: round2(cash) },
    opened,
    closed,
    stillOpen,
    rejected,
    snapshot,
  };
}
```

Two decisions worth understanding before you touch this:

**Exits resolve before entries.** A position closing today frees capital that a new entry could use. Doing it in the other order would understate available cash and silently reject valid trades.

**Sizing uses `startingCapital`, not live equity.** Sizing off live equity compounds position size as the book grows, which turns a modest edge into an exponential curve and a modest flaw into a wipeout. Fixed-base sizing keeps the results interpretable — you are measuring the strategy, not a leverage schedule.

- [ ] **Step 4: Write the package barrel**

`packages/portfolio/src/index.ts`:

```ts
export * from "./calendar.js";
export * from "./costs.js";
export * from "./fills.js";
export * from "./sizing.js";
export * from "./engine.js";
```

- [ ] **Step 5: Run the whole package and typecheck**

Run: `pnpm vitest run packages/portfolio` then `pnpm typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/portfolio
git commit -m "feat(portfolio): settle engine composing exits, entries, and marks"
```

---

### Task 7: Golden replay harness

**Files:**
- Create: `packages/portfolio/tests/fixtures/golden-bars.json`
- Create: `packages/portfolio/tests/golden-replay.test.ts`
- Create: `packages/portfolio/tests/fixtures/README.md`

**Interfaces:**
- Consumes: `settle` from Task 6.
- Produces: no runtime exports. This task produces a regression lock.

The single most valuable test in the repository. It runs a fixed scenario through the engine and asserts the exact final equity. Any future change to sizing, costs, slippage, or fill ordering — intentional or not — moves that number and fails the test. The engineer is then forced to state whether the change was deliberate.

- [ ] **Step 1: Write the fixture generator and the fixture**

`packages/portfolio/tests/fixtures/README.md`:

```markdown
# Golden replay fixtures

`golden-bars.json` is deliberately synthetic, not recorded market data.

Synthetic bars are reproducible forever, contain no licensing question, and can
be authored to exercise specific engine paths (gap-through, same-session
stop-and-target, max-hold expiry) that real data would only supply by luck.

The scenario spans 2026-07-01 to 2026-07-31 on the US calendar and covers:

- SOLID — trends up, hits its target on session 6
- GAPPY — gaps below its stop on session 4
- CHOPPY — never touches either level, force-closed at max hold
- WHIPSAW — touches both stop and target in one session

If a change to the engine moves the asserted final equity, that is the test
doing its job. Update the number only after confirming the new behaviour is
intended, and say why in the commit message.
```

`packages/portfolio/tests/fixtures/golden-bars.json` — author bars for four
symbols across the sessions 2026-07-01 through 2026-07-15 (US calendar; note
2026-07-03 is a holiday). Each entry is a full `Bar`. Use this shape:

```json
{
  "SOLID": [
    { "symbol": "SOLID", "date": "2026-07-01", "open": 100, "high": 102, "low": 99,  "close": 101, "volume": 10000 },
    { "symbol": "SOLID", "date": "2026-07-02", "open": 101, "high": 104, "low": 100, "close": 103, "volume": 11000 },
    { "symbol": "SOLID", "date": "2026-07-06", "open": 103, "high": 107, "low": 102, "close": 106, "volume": 12000 },
    { "symbol": "SOLID", "date": "2026-07-07", "open": 106, "high": 110, "low": 105, "close": 109, "volume": 13000 },
    { "symbol": "SOLID", "date": "2026-07-08", "open": 109, "high": 114, "low": 108, "close": 113, "volume": 14000 },
    { "symbol": "SOLID", "date": "2026-07-09", "open": 113, "high": 121, "low": 112, "close": 120, "volume": 15000 }
  ],
  "GAPPY": [
    { "symbol": "GAPPY", "date": "2026-07-01", "open": 200, "high": 203, "low": 198, "close": 202, "volume": 8000 },
    { "symbol": "GAPPY", "date": "2026-07-02", "open": 202, "high": 205, "low": 200, "close": 204, "volume": 8500 },
    { "symbol": "GAPPY", "date": "2026-07-06", "open": 170, "high": 175, "low": 168, "close": 172, "volume": 40000 }
  ],
  "CHOPPY": [
    { "symbol": "CHOPPY", "date": "2026-07-01", "open": 50, "high": 51, "low": 49, "close": 50.5, "volume": 6000 },
    { "symbol": "CHOPPY", "date": "2026-07-02", "open": 50.5, "high": 52, "low": 49.5, "close": 51, "volume": 6100 },
    { "symbol": "CHOPPY", "date": "2026-07-06", "open": 51, "high": 52, "low": 50, "close": 50.8, "volume": 6200 },
    { "symbol": "CHOPPY", "date": "2026-07-07", "open": 50.8, "high": 51.5, "low": 50, "close": 51.2, "volume": 6300 },
    { "symbol": "CHOPPY", "date": "2026-07-08", "open": 51.2, "high": 52, "low": 50.5, "close": 51.5, "volume": 6400 },
    { "symbol": "CHOPPY", "date": "2026-07-09", "open": 51.5, "high": 52.5, "low": 51, "close": 52, "volume": 6500 }
  ],
  "WHIPSAW": [
    { "symbol": "WHIPSAW", "date": "2026-07-01", "open": 300, "high": 305, "low": 297, "close": 303, "volume": 9000 },
    { "symbol": "WHIPSAW", "date": "2026-07-02", "open": 303, "high": 340, "low": 265, "close": 310, "volume": 90000 }
  ]
}
```

- [ ] **Step 2: Write the golden replay test**

`packages/portfolio/tests/golden-replay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { settle, type PendingEntry } from "../src/engine.js";
import { sessionsBetween } from "../src/calendar.js";
import type { Bar, Book, Position, Proposal } from "@quantrade/core";
import fixtures from "./fixtures/golden-bars.json" with { type: "json" };

const BARS = fixtures as Record<string, Bar[]>;

function barsFor(date: string): Record<string, Bar> {
  const out: Record<string, Bar> = {};
  for (const [symbol, series] of Object.entries(BARS)) {
    const bar = series.find((b) => b.date === date);
    if (bar) out[symbol] = bar;
  }
  return out;
}

function proposal(over: Partial<Proposal>): Proposal {
  return {
    id: "x", bookId: "b-us", symbol: "SOLID", direction: "long",
    conviction: 0.6, stopLoss: 0, target: 0, maxHoldSessions: 5,
    thesis: "golden", rulesApplied: [], whatWouldFalsifyThis: "n/a",
    status: "approved",
    ...over,
  } as Proposal;
}

/** All four positions are opened on the first session, then the book runs
 *  untouched. Nothing is re-proposed, so the only thing under test is the
 *  engine's own exit and marking behaviour. */
const ENTRIES: Record<string, PendingEntry[]> = {
  "2026-07-01": [
    { proposal: proposal({ id: "p-solid",   symbol: "SOLID",   stopLoss: 94,  target: 120, maxHoldSessions: 10 }), sector: "IT" },
    { proposal: proposal({ id: "p-gappy",   symbol: "GAPPY",   stopLoss: 190, target: 240, maxHoldSessions: 10 }), sector: "ENERGY" },
    { proposal: proposal({ id: "p-choppy",  symbol: "CHOPPY",  stopLoss: 45,  target: 60,  maxHoldSessions: 3  }), sector: "FMCG" },
    { proposal: proposal({ id: "p-whipsaw", symbol: "WHIPSAW", stopLoss: 270, target: 335, maxHoldSessions: 10 }), sector: "PHARMA" },
  ],
};

const SECTORS = { SOLID: "IT", GAPPY: "ENERGY", CHOPPY: "FMCG", WHIPSAW: "PHARMA" };

function replay() {
  let book: Book = {
    id: "b-us", market: "US", currency: "USD",
    startingCapital: 999_999, cash: 999_999,
  };
  let open: Position[] = [];
  const closed: Position[] = [];
  const snapshots = [];

  for (const date of sessionsBetween("US", "2026-07-01", "2026-07-15")) {
    const r = settle({
      book, date,
      openPositions: open,
      pendingEntries: ENTRIES[date] ?? [],
      bars: barsFor(date),
      sectors: SECTORS,
    });
    book = r.book;
    open = r.stillOpen;
    closed.push(...r.closed);
    snapshots.push(r.snapshot);
  }

  return { book, open, closed, snapshots };
}

describe("golden replay", () => {
  it("produces the expected exit reason for each archetype", () => {
    const { closed } = replay();
    const byId = Object.fromEntries(closed.map((c) => [c.proposalId, c]));

    expect(byId["p-solid"]?.exitReason).toBe("target");
    expect(byId["p-gappy"]?.exitReason).toBe("stop");
    expect(byId["p-choppy"]?.exitReason).toBe("max_hold");
    expect(byId["p-whipsaw"]?.exitReason).toBe("stop");
  });

  it("fills the gapped stop at the open, not at the stop price", () => {
    const { closed } = replay();
    const gappy = closed.find((c) => c.proposalId === "p-gappy")!;
    // Opened at 170, well below the 190 stop.
    expect(gappy.exitPrice!).toBeLessThan(190);
    expect(gappy.exitPrice!).toBeCloseTo(170 * (1 - 0.0015), 2);
  });

  it("gives the stop priority on the whipsaw session", () => {
    const { closed } = replay();
    const whip = closed.find((c) => c.proposalId === "p-whipsaw")!;
    expect(whip.exitReason).toBe("stop");
    expect(whip.exitDate).toBe("2026-07-02");
  });

  it("closes every position and leaves the book flat", () => {
    const { open, closed } = replay();
    expect(closed).toHaveLength(4);
    expect(open).toHaveLength(0);
  });

  it("LOCKS the final equity — see fixtures/README.md before changing this", () => {
    const { snapshots } = replay();
    const final = snapshots.at(-1)!;
    // Fill this in from the first green run, then never edit it casually.
    expect(final.equity).toBe(REPLACE_WITH_ACTUAL);
    expect(final.deployed).toBe(0);
  });

  it("never lets net P&L exceed gross P&L", () => {
    const { closed } = replay();
    for (const c of closed) {
      expect(c.netPnl!).toBeLessThanOrEqual(c.grossPnl!);
    }
  });
});
```

- [ ] **Step 3: Run it and record the locked equity**

Run: `pnpm vitest run packages/portfolio/tests/golden-replay.test.ts`

The final assertion will fail because `REPLACE_WITH_ACTUAL` is not a number.
Read the actual equity from the failure output, verify it is plausible by hand
(starting capital 999,999, four positions of roughly 5% notional each, one
winner and three losers — expect a figure slightly below 999,999), then
substitute it literally.

Do **not** replace the assertion with something loose like
`toBeGreaterThan(0)`. A range assertion here defeats the entire purpose of the
task.

- [ ] **Step 4: Re-run the full suite**

Run: `pnpm test`
Expected: every test PASSES across both packages.

- [ ] **Step 5: Verify the lock actually locks**

Temporarily change `SLIPPAGE_RATE` in `src/fills.ts` from `0.0015` to `0.003`.

Run: `pnpm vitest run packages/portfolio/tests/golden-replay.test.ts`
Expected: the equity assertion FAILS.

Revert the change and confirm the suite is green again. If the test passed with
doubled slippage, the harness is not wired to the engine and must be fixed
before this task is considered complete.

- [ ] **Step 6: Commit**

```bash
git add packages/portfolio/tests
git commit -m "test(portfolio): golden replay harness locking simulator behaviour"
```

---

## Definition of Done

- [ ] `pnpm test` passes with every test in `packages/core` and `packages/portfolio` green.
- [ ] `pnpm typecheck` is clean under `strict` and `noUncheckedIndexedAccess`.
- [ ] No `fetch`, no `Date.now()`, and no `new Date()` without an explicit argument anywhere in `packages/portfolio/src`. Verify with:
      `grep -rn "fetch(\|Date.now()\|new Date()" packages/portfolio/src` — expect no matches.
- [ ] The golden replay equity is a hard-coded literal, and Step 5 of Task 7 has been performed and confirmed to fail on a deliberate change.
- [ ] Seven commits exist, one per task.

## What this plan deliberately does not build

Network access, LLM calls, database persistence, and the web UI. Those are Plans 2, 3, and 4. The engine must be provably correct in isolation first — every later plan depends on these numbers being right, and none of them can help verify it.

