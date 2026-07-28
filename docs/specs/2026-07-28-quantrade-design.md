# QuanTrade — Design Spec

**Date:** 2026-07-28
**Status:** Approved for planning
**Repo:** https://github.com/whothemyst-byte/QuanTrade.git
**Supabase project:** `kdjghlybcecvzowxzsqz` (via `quantrade` MCP)

---

## 1. Purpose

A paper-trading system in which an LLM agent researches the US and Indian equity
markets each day, proposes swing trades to a human for approval, executes the
approved ones against a simulated account, and periodically rewrites its own
strategy document (`AGENT.md`) based on what the closed trades taught it.

The system exists to answer one question honestly: **does an LLM agent, given
market data and news, produce trade ideas that beat buying the index?**

Every design decision below is subordinate to that question. Where a choice
would make results look better without making them truer, the spec takes the
less flattering option.

### Hard constraint: zero cost

Development and ongoing operation must cost nothing, with no trial period that
expires into a bill. Section 10 audits every dependency against this.

---

## 2. Scope

### In scope

- Two independent paper books: **₹999,999 (NSE)** and **$999,999 (US)**.
- Swing trades, 2–10 session holding period, long and short.
- Daily agent runs producing ranked proposals with written theses.
- Human approve/reject on every proposal, with rejected ideas tracked as
  shadow trades.
- Simulated execution with slippage, spread, and per-market transaction costs.
- Per-trade post-mortems, and periodic reflection runs that amend `AGENT.md`
  as git commits.
- Web cockpit: proposal inbox, open positions, trade journal, equity curve
  benchmarked against NIFTY 50 and SPY, and AGENT.md history.
- Telegram push when proposals need a decision.

### Out of scope

- Real money. No broker credentials, no order routing, ever, in this codebase.
- Intraday trading, options, futures, forex, crypto.
- Multi-user accounts, auth beyond a single owner, billing.
- Backtesting over historical periods. The system trades forward only.
  (A golden-replay harness exists for *testing the engine*, not for strategy
  research.)
- Model fine-tuning. Learning happens in `AGENT.md`, not in weights.

---

## 3. Architecture

Five units, each with one purpose, a defined interface, and independent tests.

```
                    ┌──────────────────────────────────────┐
  GitHub Actions    │  packages/market   (data adapters)   │
  cron ×2 daily ───▶│  Yahoo primary · Stooq fallback      │
                    └──────────────┬───────────────────────┘
                                   │ OHLCV, fundamentals, news
                    ┌──────────────▼───────────────────────┐
                    │  packages/signals  (pure functions)  │
                    │  RSI, MA state, ATR, vol anomaly…    │
                    └──────────────┬───────────────────────┘
                                   │ ranked digest, top ~15
                    ┌──────────────▼───────────────────────┐
                    │  agent/            (the LLM)         │
                    │  reads AGENT.md → JSON proposals     │
                    └──────────────┬───────────────────────┘
                                   │ proposals
                    ┌──────────────▼───────────────────────┐
                    │  Supabase Postgres                   │
                    └──────┬───────────────────────┬───────┘
                           │                       │
              approve/reject│                       │fills, marks, exits
                    ┌──────▼───────┐      ┌────────▼─────────────────┐
                    │  apps/web    │      │  packages/portfolio      │
                    │  (Next.js)   │      │  ledger, costs, stops    │
                    └──────────────┘      └──────────────────────────┘
```

Data flows one direction. The signal layer does not know an LLM exists. The
portfolio engine does not know the internet exists. Both are pure and testable
without mocks beyond fixtures.

### 3.1 `packages/market` — data layer

A single `MarketAdapter` interface with two implementations, because Yahoo
Finance serves `AAPL` and `RELIANCE.NS` through the same endpoints:

```ts
interface MarketAdapter {
  dailyBars(symbol: string, from: Date, to: Date): Promise<Bar[]>;
  quote(symbol: string): Promise<Quote>;
  news(symbol: string, since: Date): Promise<NewsItem[]>;
  isSessionOpen(at: Date): boolean;
  nextSessionOpen(after: Date): Date;
}
```

- `YahooAdapter` — primary for both markets. Keyless.
- `StooqAdapter` — EOD fallback for bars when Yahoo rate-limits or breaks.
- Market calendars (NSE and NYSE holidays) are static JSON, updated yearly.
  A wrong calendar silently corrupts fill dates, so calendar correctness has
  its own tests.

Bars are cached in `daily_bars` on fetch. The agent never re-downloads history
it already has, which keeps request volume trivially low.

### 3.2 `packages/signals` — deterministic feature extraction

Pure functions, `Bar[] → number | enum`. No AI, no network, no state.

RSI(14), SMA20/50/200 and their crossover state, ATR(14), distance from
52-week high/low, 20-day volume ratio, gap percentage, 5- and 20-day return,
realised volatility.

Two jobs:

1. **Rank the universe.** A deterministic composite score narrows ~200 tickers
   to the ~15 the LLM will actually consider. This is the primary cost control:
   the model reasons over 15 stocks, never 5,000.
2. **Compress charts into language.** The LLM never sees raw candles. It sees
   *"RSI 28, below its 200-day for 12 sessions, volume 2.3× its 20-day average,
   9% off the 52-week low."* Text an LLM can reason about, computed by code
   that cannot hallucinate.

### 3.3 `agent/` — the reasoning layer

Input: `AGENT.md` (full text) + the ~15-candidate digest + news headlines per
candidate + current book state (cash, open positions, sector exposure) + the
last 10 closed trades with outcomes.

Output: schema-validated JSON.

```jsonc
{
  "market_view": "one paragraph on regime and posture",
  "proposals": [{
    "symbol": "RELIANCE.NS",
    "direction": "long",
    "conviction": 0.72,          // 0–1
    "stop_loss": 2810.0,         // absolute price, mandatory
    "target": 3120.0,            // mandatory
    "max_hold_sessions": 8,
    "thesis": "why, in plain language",
    "rules_applied": ["R-004", "R-011"],   // AGENT.md rule IDs
    "what_would_falsify_this": "the observation that proves me wrong"
  }],
  "no_trade_reason": "populated instead of proposals when standing aside"
}
```

Notes on the schema:

- **No entry price.** Entry is the next session's open, decided by the engine,
  not the agent. This removes an entire class of look-ahead cheating.
- **No position size.** Size is derived from the stop distance by the risk
  formula in §5.3. The agent cannot size its way around risk limits.
- `rules_applied` is what makes rule hit-rates computable — it links each
  outcome back to the beliefs that produced it.
- `what_would_falsify_this` forces a testable claim and gives the post-mortem
  something concrete to check.

Model routing: **Groq (free tier) primary, Gemini (free tier) failover.**
Malformed JSON retries once with the validation error appended; a second
failure aborts the run and logs it rather than guessing.

**Standing aside is a valid, logged outcome.** An agent that must produce a
trade every day will produce bad trades. `no_trade_reason` is a first-class
result.

### 3.4 `packages/portfolio` — the simulator

Pure functions over a ledger. Given the current book, a set of approved
proposals, and today's bars, it returns the new book state and an event log.
No network, no clock — the current time is always an argument. This is what
makes the golden-replay test possible.

Responsibilities: fill approved proposals at the next open, mark open positions
to market, evaluate stops and targets against the day's high/low, force-close
at max hold, apply all costs, and write equity snapshots.

### 3.5 `apps/web` — the cockpit

Next.js on Vercel. Screens:

- **Inbox** — pending proposals with full thesis, signals, and news, plus
  approve/reject. Shows expiry countdown.
- **Positions** — open positions, live-ish marks, unrealised P&L, days held,
  distance to stop and target.
- **Journal** — closed trades, each showing the original thesis, the
  falsification claim, the outcome, and the post-mortem verdict.
- **Performance** — equity curve per book against NIFTY 50 / SPY buy-and-hold,
  plus the real book vs the shadow book.
- **Mind** — current `AGENT.md` rendered, with rule hit-rates, and the commit
  history of its amendments.

Single owner. Supabase RLS with one authenticated user; the service role key
lives only in GitHub Actions secrets and never reaches the browser.

---

## 4. The learning loop

### 4.1 `AGENT.md` structure

One file at the repo root, four zones with different edit permissions:

| Zone | Editable by agent | Contents |
|---|---|---|
| **Core Mandate** | **No — human only** | Risk limits, mandatory stop rule, forbidden behaviours |
| **Market Beliefs** | Yes | Learned observations about how these markets behave |
| **Active Rules** | Yes | Numbered, evidence-backed decision rules |
| **Known Failure Modes** | Yes | Mistakes made, written as warnings to its future self |

Every Active Rule carries structured metadata:

```markdown
### R-007 — Avoid longs into NSE earnings within 3 sessions
- **Born:** 2026-08-14 (reflection #3)
- **Evidence:** T-041, T-047, T-052, T-058, T-061
- **Since born:** 9 applications, 6 wins, +2.1% avg
- **Status:** active
```

Rule IDs are permanent and never reused. Retired rules stay in the file struck
through, with the reason, so the agent does not rediscover an idea it already
disproved.

### 4.2 Post-mortems — cheap, immediate, non-mutating

When a position closes, the agent writes a post-mortem **to the database**. It
does not touch `AGENT.md`. Each post-mortem must classify the trade into
exactly one category:

- `thesis_wrong` — the reasoning was wrong.
- `thesis_right_timing_wrong` — correct call, wrong window.
- `rule_violated` — the idea contradicted an existing rule and was taken anyway.
- `unmodelled_event` — something no available signal could have predicted.
- `correct` — worked for the stated reason.

This taxonomy is the point. `thesis_wrong` should change beliefs;
`rule_violated` should change process discipline; `unmodelled_event` should
change **nothing at all**. An agent that conflates these will thrash — it will
keep rewriting a sound strategy in response to noise.

### 4.3 Reflection runs — where AGENT.md changes

Triggered every **10 closed trades per book**, never on a schedule and never
after a single trade. A reflection run reads every post-mortem since the last
reflection, plus the hit-rate of each active rule, and proposes amendments.

Guardrails, all enforced in code rather than by asking the model nicely:

1. **Evidence floor.** A new rule requires >= 5 supporting closed trades. Fewer
   is anecdote.
2. **Hard cap of 15 active rules.** To add a 16th, one must be retired in the
   same commit. This forces the agent to decide what it believes *most*
   instead of endlessly accreting rules.
3. **Automatic probation.** Any rule whose hit-rate falls below 45% over >= 10
   applications is moved to `probation` by code, not judgement. Two consecutive
   failing reflections retire it.
4. **`unmodelled_event` trades are excluded** from rule evidence entirely.
5. **Core Mandate is verified byte-identical** after every agent write. Any
   change fails the run and reverts the commit.

### 4.4 Versioning is git

Each reflection commits `AGENT.md` with the summary as the message and the
covered trade IDs in the body. Consequences, all free:

- The agent's complete intellectual history is `git log AGENT.md`.
- Any two eras of its thinking are `git diff`-able.
- If a reflection makes it worse, `git revert` restores its previous mind
  exactly.
- The Mind screen renders this history with no extra storage.

The commit SHA is recorded on the `reflections` row, so every trade can be
traced to the exact version of the strategy that produced it.

---

## 5. Execution realism

The credibility of every number in this system rests on this section.

### 5.1 No look-ahead

The agent runs **after a session closes**. Proposals fill at the **next
session's open**, never at the close the decision was based on. Signals are
computed only from bars available at decision time. Violating this is the most
common way paper trading produces fantasy returns.

### 5.2 Costs and slippage

| | India (NSE, delivery) | US |
|---|---|---|
| Brokerage | 0 (discount broker, delivery) | $0 |
| STT | 0.1% buy + 0.1% sell | — |
| Stamp duty | 0.015% buy | — |
| Exchange + SEBI | ~0.00335% | ~0.003% |
| SEC + TAF | — | ~0.003% sell |
| GST | 18% on brokerage + txn charges | — |
| **Slippage** | **0.15% each way** | **0.15% each way** |
| **Round-trip total** | **approx 0.55%** | **approx 0.31%** |

Implemented as `costModel(market, side, qty, price)` returning an itemised
breakdown stored on the position. Costs are never netted silently into P&L —
the journal shows gross P&L, costs, and net separately, because a strategy that
is profitable gross and losing net is a specific, important failure.

### 5.3 Fills, stops, and the conservative tie-break

- Entry fills at next session's open plus/minus slippage.
- Stops and targets evaluate against the session's **high and low**.
- **If both the stop and the target are touched in the same session, the stop
  is assumed to have hit first.** Intraday sequencing is unknowable from daily
  bars, and the optimistic assumption is how backtests lie.
- **Gap-through:** if the open is already past the stop, the fill is the
  **open**, not the stop price. Stops do not protect against gaps in reality
  and must not appear to here.
- Force-close at the open of session 11, or the agent's stated
  `max_hold_sessions`, whichever is sooner.
- Shorts on NSE: delivery shorts are not permitted in the real market, so short
  proposals for NSE are rejected by the engine at validation. US shorts are
  allowed with a borrow-cost stub of 0.01%/day.

### 5.4 Risk limits (Core Mandate — agent cannot edit)

- Risk per trade <= **2% of book equity**. Size derives from the stop:
  `qty = floor((equity * 0.02) / abs(entry - stop))`.
- Position value <= **5% of equity** after sizing (caps tight-stop blowups).
- Sector exposure <= **25%** of equity.
- Deployed capital <= **60%** of equity.
- Maximum **8 open positions** per book.
- Every proposal must carry a stop. No stop, no trade — validated in code.
- If a proposal breaches any limit, it is **rejected by the engine before it
  reaches the inbox**, with the reason logged and fed back into the agent's
  next context so it learns the constraint.

### 5.5 Universe

- **India:** NIFTY 100 constituents.
- **US:** ~100 liquid large caps (S&P 100).
- Static JSON lists, reviewed quarterly. Deliberately excludes illiquid names
  where the slippage model would be a fiction.

---

## 6. Data model (Supabase)

| Table | Purpose | Key columns |
|---|---|---|
| `books` | The two paper accounts | `market`, `currency`, `starting_capital`, `cash` |
| `instruments` | Universe | `symbol`, `market`, `name`, `sector` |
| `daily_bars` | OHLCV cache | `symbol`, `date`, `o/h/l/c/v` — PK `(symbol, date)` |
| `runs` | Every agent invocation | `type` (`proposal`/`reflection`/`settle`), `status`, `model`, `tokens`, `error` |
| `proposals` | Agent output | `symbol`, `direction`, `conviction`, `stop`, `target`, `thesis`, `rules_applied`, `signals_snapshot` jsonb, `status`, `decided_at` |
| `positions` | Real and shadow | `proposal_id`, `qty`, `entry_price`, `entry_date`, `exit_price`, `exit_reason`, `gross_pnl`, `costs`, `net_pnl`, `is_shadow` |
| `post_mortems` | Per closed trade | `position_id`, `category`, `expected`, `actual`, `lesson` |
| `reflections` | AGENT.md amendments | `run_id`, `trades_covered`, `commit_sha`, `summary`, `rules_added`, `rules_retired` |
| `equity_snapshots` | Daily curve | `book_id`, `date`, `equity`, `cash`, `deployed`, `benchmark_value` |

`proposals.status`: `pending` -> `approved` / `rejected` / `expired` /
`engine_rejected`.

**Shadow book:** every `rejected` proposal still creates a `positions` row with
`is_shadow = true`, simulated by the identical engine. This costs almost
nothing and answers the two questions that otherwise stay unanswerable — is the
agent any good, and is the human's filtering adding or destroying value?

Migrations are applied through the `quantrade` MCP and committed as SQL files
under `supabase/migrations/`.

---

## 7. Scheduling

GitHub Actions cron, all times UTC in the workflow, IST noted for humans:

| Job | When | Does |
|---|---|---|
| `nse-propose` | 03:15 UTC (08:45 IST), Mon–Fri | Proposals for NSE, ~30 min before open |
| `nse-settle` | 10:15 UTC (15:45 IST), Mon–Fri | Fills, marks, stops, exits, post-mortems |
| `us-propose` | 12:30 UTC (18:00 IST), Mon–Fri | Proposals for US, ~1 hr before open |
| `us-settle` | 21:15 UTC (02:45 IST), Mon–Fri | Fills, marks, stops, exits, post-mortems |
| `reflect` | Triggered by settle when a book crosses 10 closed trades | Amends AGENT.md, commits |

Proposals expire if undecided by 15 minutes before the relevant open. Expired
proposals are recorded as `expired` and simulated in the shadow book — so
inaction is measured too.

Holiday-aware: jobs exit immediately on non-session days per the market
calendar.

---

## 8. Testing strategy

- **Pure-unit, fixture-based, no network:** every signal function, the cost
  model, the sizing formula, the fill engine, and the market calendars.
- **Golden replay:** a fixed set of ~60 sessions of recorded bars plus a fixed
  proposal set runs through the portfolio engine and asserts exact fills,
  costs, exits, and final equity. Any unintended change to simulation
  behaviour fails this test. This is the single most valuable test in the repo.
- **Adversarial bar tests:** gap-through-stop, same-session stop-and-target,
  halted session, zero volume, missing bar, stock split.
- **Schema tests:** malformed, truncated, and hallucinated-symbol agent
  responses are all rejected safely.
- **Guardrail tests:** rules cannot exceed 15; Core Mandate edits are detected
  and reverted; an under-evidenced rule is refused.
- **Live smoke:** a manual workflow that runs the full pipeline against a
  throwaway book and asserts it completes.

LLM calls are mocked everywhere except the live smoke test.

---

## 9. Failure modes and honest expectations

| Risk | Mitigation |
|---|---|
| Yahoo Finance is unofficial and may break | Stooq fallback for bars; run fails loudly with a Telegram alert rather than trading on stale data |
| Free LLM rate limits or outage | Groq -> Gemini failover; a failed run skips the day rather than degrading |
| Supabase free tier pauses after 7 idle days | Daily cron keeps it awake |
| Agent overfits to recent trades | Section 4.3 guardrails: evidence floor, rule cap, auto-probation |
| Stale market calendar corrupts fill dates | Calendar tests; yearly review task |
| Silent data corruption | Bars validated on write: `h >= max(o,c)`, `l <= min(o,c)`, `v >= 0` |

**Stated plainly:** the base rate for discretionary strategies beating a
buy-and-hold index is poor, and there is no strong prior that an LLM reading
headlines changes that. The benchmark line is on the front page from day one
for exactly this reason. A result of *"the agent underperformed NIFTY by 6%
over 60 trades"* is a successful outcome for this project — it is a real
answer, cheaply obtained. The failure case is not losing to the index; it is
building a system whose numbers cannot be trusted either way.

Statistical honesty: 10 trades tell you nothing, 30 hint, 100 begin to mean
something. The Performance screen displays trade count alongside every return
figure, and suppresses win-rate percentages below 20 closed trades.

---

## 10. Cost audit

| Component | Service | Free tier | Our usage |
|---|---|---|---|
| Web app | Vercel Hobby | Unlimited personal projects | 1 small app |
| Database | Supabase Free | 500 MB, pauses at 7 idle days | < 50 MB; daily cron prevents pause |
| Scheduler | GitHub Actions | 2,000 min/month (private) | ~120 min/month |
| Market data | Yahoo Finance | Keyless, unofficial | ~200 symbol-days per run, cached |
| Fallback data | Stooq | Keyless CSV | Failover only |
| LLM | Groq free tier | Generous rate limits | 2–4 calls/day |
| LLM failover | Gemini free tier | 15 RPM / 1,500 RPD | Failover only |
| Notifications | Telegram Bot API | Free, unlimited | ~4 messages/day |
| Repo + AGENT.md history | GitHub | Free | — |

**No trials, no cards on file, nothing that expires into a bill.** The only
scaling risk is Supabase storage, and `daily_bars` — the sole growing table —
adds roughly 10 MB/year at this universe size.

---

## 11. Success criteria

The build is complete when:

1. Both books run unattended for 10 consecutive session days with no manual
   intervention.
2. Golden-replay tests pass and pin the simulator's behaviour.
3. A proposal can be approved from a phone and appears as a position with
   correctly modelled costs at the next open.
4. A rejected proposal appears in the shadow book with an identical simulation.
5. At least one reflection run has amended `AGENT.md` as a git commit, with
   every guardrail in Section 4.3 verified by tests.
6. The Performance screen shows both books against their benchmarks, with
   trade counts, and refuses to display win rates below 20 trades.
7. A full month of operation has incurred zero cost.
