import type { SymbolFeatures } from "./features.js";

function n(value: number | null, suffix = "", dp = 1): string {
  return value === null ? "n/a" : `${value.toFixed(dp)}${suffix}`;
}

function trendPhrase(f: SymbolFeatures): string {
  if (f.trend === "unknown") return "200-day trend n/a";
  return f.trend === "above200" ? "above its 200-day" : "below its 200-day";
}

/**
 * Render features as prose the model can reason about. The LLM never receives
 * raw candles — partly for context economy, but mainly because a model asked
 * to eyeball 250 numbers will invent patterns in them.
 */
export function buildDigest(features: SymbolFeatures[]): string {
  if (features.length === 0) {
    return "No candidates cleared the screen today.";
  }

  return features
    .map((f) =>
      [
        `${f.symbol} (${f.sector}) — last ${n(f.close, "", 2)}`,
        `  RSI ${n(f.rsi14)}, ${trendPhrase(f)}, volume ${n(f.volRatio20, "x", 1)} its 20-day average`,
        `  5-day ${n(f.ret5, "%")}, 20-day ${n(f.ret20, "%")}, gap ${n(f.gapPct, "%")}`,
        `  ${n(f.pctFrom52wHigh, "%")} from the 52-week high, ${n(f.pctFrom52wLow, "%")} from the low`,
        `  ATR ${n(f.atrPct, "% of price", 2)}, realised vol ${n(f.realisedVol20, "%")}`,
      ].join("\n"),
    )
    .join("\n\n");
}
