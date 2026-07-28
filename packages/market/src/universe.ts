import type { Market } from "@quantrade/core";
import nifty100 from "./universe/nifty100.json";
import sp100 from "./universe/sp100.json";

export interface Instrument {
  symbol: string;
  name: string;
  sector: string;
}

/**
 * One shared sector vocabulary across both markets. The 25% sector cap in
 * @quantrade/portfolio compares these strings directly, so "Tech" in one file
 * and "Technology" in the other would silently defeat the limit.
 */
export const SECTORS = [
  "Technology",
  "Communication",
  "Financials",
  "Healthcare",
  "Energy",
  "Industrials",
  "Materials",
  "Utilities",
  "ConsumerDiscretionary",
  "ConsumerStaples",
  "RealEstate",
] as const;

export type Sector = (typeof SECTORS)[number];

const UNIVERSE: Record<Market, Instrument[]> = {
  NSE: nifty100 as Instrument[],
  US: sp100 as Instrument[],
};

export function universeFor(market: Market): Instrument[] {
  return UNIVERSE[market];
}

export function sectorOf(market: Market, symbol: string): string | undefined {
  return UNIVERSE[market].find((i) => i.symbol === symbol)?.sector;
}

/** Symbol -> sector map for the whole market, for the engine's `sectors` arg. */
export function sectorMap(market: Market): Record<string, string> {
  return Object.fromEntries(UNIVERSE[market].map((i) => [i.symbol, i.sector]));
}
