import type { SymbolFeatures } from "./features.js";

/**
 * Score how *interesting* a symbol is — not how bullish. The job here is to
 * hand the LLM the names where something is actually happening, and let it
 * decide direction. A momentum-biased score would quietly make the agent a
 * trend follower before it ever read a headline.
 */
export function scoreCandidate(f: SymbolFeatures): number | null {
  if (f.rsi14 === null || f.volRatio20 === null || f.ret5 === null) return null;

  const rsiStretch = Math.abs(f.rsi14 - 50) / 50;        // 0..1
  const volumeUnusual = Math.min(Math.abs(f.volRatio20 - 1), 3) / 3;
  const shortMove = Math.min(Math.abs(f.ret5), 15) / 15;
  const nearExtreme =
    f.pctFrom52wHigh === null || f.pctFrom52wLow === null
      ? 0
      : Math.max(0, 1 - Math.min(Math.abs(f.pctFrom52wHigh), Math.abs(f.pctFrom52wLow)) / 20);
  const gapping = f.gapPct === null ? 0 : Math.min(Math.abs(f.gapPct), 5) / 5;

  return (
    rsiStretch * 0.3 +
    volumeUnusual * 0.25 +
    shortMove * 0.2 +
    nearExtreme * 0.15 +
    gapping * 0.1
  );
}

export function rankCandidates(features: SymbolFeatures[], limit: number): SymbolFeatures[] {
  return features
    .map((f) => ({ f, s: scoreCandidate(f) }))
    .filter((x): x is { f: SymbolFeatures; s: number } => x.s !== null)
    // The symbol tie-break is what makes ranking deterministic — without it,
    // sort stability varies with input size and the digest would differ
    // between runs on identical data.
    .sort((a, b) => b.s - a.s || a.f.symbol.localeCompare(b.f.symbol))
    .slice(0, limit)
    .map((x) => x.f);
}
