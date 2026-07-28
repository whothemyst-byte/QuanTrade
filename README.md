# QuanTrade

An LLM agent researches the US and Indian equity markets each day, proposes
swing trades, waits for your approval, executes the approved ones against a
simulated account, and periodically rewrites its own strategy document.

**Paper only. There is no broker integration and no code path to real money.**

- Spec: [`docs/specs/2026-07-28-quantrade-design.md`](docs/specs/2026-07-28-quantrade-design.md)
- Plans: [`docs/superpowers/plans/`](docs/superpowers/plans/)
- The agent's mind: [`AGENT.md`](AGENT.md) — its history is `git log AGENT.md`

## What it does

Two independent paper books: **₹999,999 (NSE)** and **$999,999 (US)**.

1. **Propose** — before each open, the agent screens ~100 index names per
   market down to 15 by computed signals, reads their headlines, and proposes
   up to 3 trades with a stop, a target, a thesis, and what would falsify it.
2. **You decide** — approve or reject from your phone. Rejected and expired
   proposals are still simulated as a **shadow book**, so you can see whether
   your filtering helps or hurts.
3. **Settle** — after the close, positions fill at the *next* open, stops and
   targets resolve against the day's high and low, costs are applied, and the
   agent writes a post-mortem on every closed trade.
4. **Reflect** — every 10 closed trades, the agent proposes amendments to
   `AGENT.md` and commits them. Guardrails are enforced in code, not by asking
   the model nicely.

## Layout

```
packages/core       types, money rounding, validation schemas
packages/portfolio  calendars, costs, sizing, fills, the settle engine
packages/market     Yahoo adapters, failover, universe lists
packages/signals    indicators, feature extraction, ranking, digest
packages/db         Supabase access layer
agent/              AGENT.md guardrails, LLM client, the three jobs
apps/web/           Next.js cockpit
```

## Running the tests

Everything runs offline. No network, no database, no LLM.

```bash
pnpm install
pnpm test        # 271 tests
pnpm typecheck
```

A good sanity check: **turn your wifi off and run `pnpm test` again.** It must
still pass. Any failure means a test is reaching the live internet, which is a
bug in the test.

## Setup

### 1. Free accounts you need

| Service | What for | Cost |
|---|---|---|
| [Groq](https://console.groq.com) | Primary LLM | Free tier |
| [Google AI Studio](https://aistudio.google.com/apikey) | Gemini failover | Free tier |
| [Telegram BotFather](https://t.me/botfather) | Push when proposals wait | Free |
| GitHub | Scheduler | Free |
| Vercel | Hosting | Free hobby |

Supabase project `kdjghlybcecvzowxzsqz` is already created and migrated.

To get your Telegram chat ID: message your new bot once, then open
`https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[0].message.chat.id`.

### 2. GitHub Actions secrets

Settings → Secrets and variables → Actions:

```
SUPABASE_URL                 https://kdjghlybcecvzowxzsqz.supabase.co
SUPABASE_SERVICE_ROLE_KEY    (Supabase dashboard → Project Settings → API)
GROQ_API_KEY
GEMINI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

### 3. Vercel environment variables

```
NEXT_PUBLIC_SUPABASE_URL         https://kdjghlybcecvzowxzsqz.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY    (the anon/publishable key)
OWNER_EMAIL                      your email — the only account allowed in
```

`SUPABASE_SERVICE_ROLE_KEY` must **not** be set here. The web app has no need
for it, and adding it would put a full-access credential one misconfiguration
away from the browser.

Then add your deployment origin under Supabase → Authentication → URL
Configuration → Redirect URLs, or the magic links will bounce.

### 4. Deploy

```bash
cd apps/web && npx vercel --prod
```

## Running a job by hand

GitHub → Actions → QuanTrade → Run workflow. Pick `propose` / `settle` /
`reflect` and a market.

Locally:

```bash
export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GROQ_API_KEY=...
npx tsx agent/src/cli.ts propose US
```

## Schedule

| Job | UTC | IST |
|---|---|---|
| propose NSE | 03:15 | 08:45 |
| settle NSE | 10:15 | 15:45 |
| propose US | 12:30 | 18:00 |
| settle US | 21:15 | 02:45 |

Reflection is triggered by a settle once a book crosses 10 closed trades.

## Design decisions worth knowing

These will look wrong until you know why:

- **Sizing uses starting capital, not live equity.** No compounding. It
  measures the strategy, not a leverage schedule.
- **The stop wins any same-session stop-vs-target tie**, and a gap through the
  stop fills at the open. Daily bars cannot tell us which came first, so the
  unfavourable assumption is the only defensible one.
- **The golden-replay test hard-codes an exact final equity** (997,719.19).
  Changing costs, slippage, sizing, or fill ordering will fail it. That is the
  point — the change has to be defended, not absorbed.
- **A missing bar fails the whole settle.** A partial settle would mark some
  positions and not others, then double-count on retry.
- **NSE has no fallback data source.** Stooq began serving a JavaScript
  challenge to non-browser clients in July 2026, so the fallback is Yahoo's
  second host. A Yahoo-wide outage fails the run rather than trading on
  substitute data.
- **Win rate is hidden below 20 closed trades**, and the screen says so.

## Honest expectations

The base rate for discretionary strategies beating a buy-and-hold index is
poor, and there is no strong prior that an LLM reading headlines changes that.
The benchmark line is on the Performance screen from day one for exactly this
reason.

*"The agent underperformed NIFTY by 6% over 60 trades"* is a successful outcome
for this project — a real answer, cheaply obtained. The failure case is not
losing to the index; it is building a system whose numbers cannot be trusted
either way.

Ten trades tell you nothing. Thirty hint. A hundred begin to mean something.
