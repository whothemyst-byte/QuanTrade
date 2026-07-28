import type { Bar } from "@quantrade/core";
import { atr, pctChange, realisedVol, rsi, sma, volumeRatio } from "./indicators.js";

export interface SymbolFeatures {
  symbol: string;
  sector: string;
  close: number;
  rsi14: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  trend: "above200" | "below200" | "unknown";
  atr14: number | null;
  atrPct: number | null;
  volRatio20: number | null;
  ret5: number | null;
  ret20: number | null;
  pctFrom52wHigh: number | null;
  pctFrom52wLow: number | null;
  gapPct: number | null;
  realisedVol20: number | null;
}

/** Below this, too many features are null for the symbol to be rankable. */
export const MIN_BARS = 60;

export function computeFeatures(bars: Bar[], sector: string): SymbolFeatures | null {
  if (bars.length < MIN_BARS) return null;

  const latest = bars.at(-1)!;
  const prev = bars.at(-2)!;
  const closes = bars.map((b) => b.close);

  const sma200 = sma(closes, 200);
  const atr14 = atr(bars, 14);

  const yearBars = bars.slice(-252);
  const high52 = Math.max(...yearBars.map((b) => b.high));
  const low52 = Math.min(...yearBars.map((b) => b.low));

  return {
    symbol: latest.symbol,
    sector,
    close: latest.close,
    rsi14: rsi(closes, 14),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200,
    trend: sma200 === null ? "unknown" : latest.close >= sma200 ? "above200" : "below200",
    atr14,
    atrPct: atr14 === null ? null : pctChange(latest.close, latest.close + atr14),
    volRatio20: volumeRatio(bars, 20),
    ret5: closes.length > 5 ? pctChange(closes.at(-6)!, latest.close) : null,
    ret20: closes.length > 20 ? pctChange(closes.at(-21)!, latest.close) : null,
    pctFrom52wHigh: pctChange(high52, latest.close),
    pctFrom52wLow: pctChange(low52, latest.close),
    gapPct: pctChange(prev.close, latest.open),
    realisedVol20: realisedVol(closes, 20),
  };
}
