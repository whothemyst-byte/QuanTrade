/**
 * One-off maintenance script: confirm every universe symbol actually resolves
 * on Yahoo and returns recent bars. Run it after editing a universe file, and
 * at the quarterly review. Not part of the test suite — it needs the network.
 *
 *   node packages/market/scripts/verify-universe.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

async function check(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=1mo`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return { symbol, ok: false, why: `HTTP ${res.status}` };
    const body = await res.json();
    const result = body?.chart?.result?.[0];
    const bars = result?.timestamp?.length ?? 0;
    if (!result) return { symbol, ok: false, why: body?.chart?.error?.description ?? "no result" };
    if (bars < 5) return { symbol, ok: false, why: `only ${bars} bars in the last month` };
    return { symbol, ok: true, bars };
  } catch (err) {
    return { symbol, ok: false, why: err.message };
  }
}

for (const file of ["sp100.json", "nifty100.json"]) {
  const entries = JSON.parse(readFileSync(join(here, "..", "src", "universe", file), "utf8"));
  const bad = [];
  for (const e of entries) {
    const r = await check(e.symbol);
    if (!r.ok) bad.push(r);
    await new Promise((r) => setTimeout(r, 120));
  }
  console.log(`${file}: ${entries.length} symbols, ${bad.length} failing`);
  for (const b of bad) console.log(`  FAIL ${b.symbol} — ${b.why}`);
}
