/**
 * Seed the instruments table from the verified universe lists.
 * Idempotent — re-run after editing a universe file.
 *
 *   npx tsx packages/db/scripts/seed-instruments.ts
 */
import { universeFor } from "@quantrade/market";
import { createDb } from "../src/index.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this.");
  process.exit(1);
}

const db = createDb(url, key);

for (const market of ["NSE", "US"] as const) {
  const rows = universeFor(market).map((i) => ({
    symbol: i.symbol, market, name: i.name, sector: i.sector,
  }));
  await db.upsertInstruments(rows);
  console.log(`seeded ${rows.length} ${market} instruments`);
}
