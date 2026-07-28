import type { Bar } from "@quantrade/core";

/** Every indicator returns null rather than a partial-window approximation.
 *  A half-computed RSI is not a small error, it is a meaningless number that
 *  would still rank against fully-computed ones. */

function round(value: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const window = values.slice(-period);
  return round(window.reduce((a, b) => a + b, 0) / period);
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }

  if (losses === 0) return gains === 0 ? 50 : 100;
  if (gains === 0) return 0;

  const rs = gains / losses;
  return round(100 - 100 / (1 + rs), 2);
}

export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const bar = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    trueRanges.push(
      Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose)),
    );
  }
  return round(trueRanges.reduce((a, b) => a + b, 0) / period);
}

export function pctChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return round(((to - from) / from) * 100, 2);
}

export function volumeRatio(bars: Bar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const latest = bars.at(-1)!.volume;
  const prior = bars.slice(-(period + 1), -1);
  const avg = prior.reduce((a, b) => a + b.volume, 0) / prior.length;
  if (avg === 0) return null;
  return round(latest / avg, 2);
}

/** Annualised standard deviation of daily log returns, as a percentage. */
export function realisedVol(closes: number[], period = 20): number | null {
  if (closes.length < period + 1) return null;

  const returns: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev <= 0) return null;
    returns.push(Math.log(closes[i]! / prev));
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return round(Math.sqrt(variance) * Math.sqrt(252) * 100, 2);
}
