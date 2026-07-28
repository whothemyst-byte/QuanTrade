/**
 * Entry point for the scheduled jobs.
 *
 *   npx tsx agent/src/cli.ts propose US
 *   npx tsx agent/src/cli.ts settle  NSE
 *   npx tsx agent/src/cli.ts reflect US
 *
 * Exit code policy: non-zero only for a *configuration* error. A trading run
 * that fails for data or model reasons exits zero, having already recorded and
 * notified the failure — otherwise GitHub emails a workflow failure for
 * something the system already handled and reported.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Market } from "@quantrade/core";
import { createDb } from "@quantrade/db";
import { createDataSource, universeFor, sectorMap } from "@quantrade/market";
import { isSessionDay, nextSessionDay } from "@quantrade/portfolio";
import { providersFromEnv } from "./llm/client.js";
import { notifierFromEnv } from "./notify/telegram.js";
import { runPropose } from "./jobs/propose.js";
import { runSettle } from "./jobs/settle.js";
import { runReflect } from "./jobs/reflect.js";
import { commitAgentMd } from "./git.js";

const AGENT_MD = join(process.cwd(), "AGENT.md");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

/** Today in the market's own timezone, so a run at 02:45 IST settles the
 *  correct US session rather than tomorrow's. */
function marketToday(market: Market): string {
  const tz = market === "NSE" ? "Asia/Kolkata" : "America/New_York";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function main(): Promise<void> {
  const [job, marketArg] = process.argv.slice(2);
  const market = marketArg as Market;

  if (job !== "propose" && job !== "settle" && job !== "reflect") {
    console.error(`Unknown job "${job}". Expected propose | settle | reflect.`);
    process.exit(1);
  }
  if (market !== "NSE" && market !== "US") {
    console.error(`Unknown market "${marketArg}". Expected NSE | US.`);
    process.exit(1);
  }

  const db = createDb(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const providers = providersFromEnv();
  const notify = notifierFromEnv();
  const data = createDataSource();
  const agentMd = await readFile(AGENT_MD, "utf8");

  const today = marketToday(market);
  console.log(`[${job}] ${market} ${today}`);

  if (job === "propose") {
    if (!isSessionDay(market, today)) {
      console.log(`${today} is not a ${market} session day; nothing to propose.`);
      return;
    }
    // Proposals expire 15 minutes before the session they would fill at.
    const fillDay = nextSessionDay(market, today);
    const openUtc = market === "NSE" ? "03:45:00.000Z" : "13:30:00.000Z";
    const expiresAt = new Date(
      new Date(`${fillDay}T${openUtc}`).getTime() - 15 * 60_000,
    ).toISOString();

    const result = await runPropose(
      { db, data, providers, agentMd, universe: universeFor(market), notify, expiresAt },
      market,
      today,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (job === "settle") {
    const result = await runSettle(
      { db, data, providers, agentMd, sectors: sectorMap(market), notify },
      market,
      today,
    );
    console.log(JSON.stringify(result, null, 2));

    if (result.shouldReflect) {
      console.log("Reflection threshold reached; running reflect.");
      await reflect(market);
    }
    return;
  }

  await reflect(market);

  async function reflect(m: Market): Promise<void> {
    const bookId = m === "NSE" ? "nse-main" : "us-main";
    const result = await runReflect(
      {
        db, providers,
        readAgentMd: () => readFile(AGENT_MD, "utf8"),
        writeAgentMd: (c) => writeFile(AGENT_MD, c, "utf8"),
        commit: commitAgentMd,
        loadPostMortems: async () => {
          const { data: rows, error } = await db.raw
            .from("post_mortems")
            .select("position_id, category, lesson, positions!inner(symbol, net_pnl, qty, entry_price, book_id)")
            .eq("positions.book_id", bookId);
          if (error) throw new Error(`loadPostMortems: ${error.message}`);
          return (rows ?? []).map((r: any) => {
            const pos = Array.isArray(r.positions) ? r.positions[0] : r.positions;
            const notional = Number(pos?.qty ?? 0) * Number(pos?.entry_price ?? 0);
            return {
              positionId: r.position_id,
              symbol: pos?.symbol ?? "unknown",
              category: r.category,
              netPct: notional ? (Number(pos?.net_pnl ?? 0) / notional) * 100 : 0,
              lesson: r.lesson,
            };
          });
        },
        reflectionNumber: (await db.countReflections(bookId)) + 1,
        today: marketToday(m),
        notify,
      },
      m,
    );
    console.log(JSON.stringify(result, null, 2));
  }
}

await main();
