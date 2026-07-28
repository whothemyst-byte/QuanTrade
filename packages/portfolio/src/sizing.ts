import { round2, type Direction, type Market, type Position } from "@quantrade/core";

export const RISK_PER_TRADE = 0.02;   // 2% of equity
export const MAX_POSITION_PCT = 0.05; // 5% of equity
export const MAX_SECTOR_PCT = 0.25;
export const MAX_DEPLOYED_PCT = 0.6;
export const MAX_OPEN_POSITIONS = 8;

export interface SizingInput {
  equity: number;
  entryPrice: number;
  stopLoss: number;
  direction: Direction;
}

export interface SizingResult {
  qty: number;
  riskAmount: number;
  notional: number;
}

export function sizePosition({ equity, entryPrice, stopLoss, direction }: SizingInput): SizingResult {
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance === 0) {
    throw new Error("Stop loss cannot equal the entry price — risk would be undefined");
  }
  void direction; // absolute distance covers both sides

  const riskBudget = equity * RISK_PER_TRADE;
  const byRisk = Math.floor(riskBudget / stopDistance);
  const byNotional = Math.floor((equity * MAX_POSITION_PCT) / entryPrice);
  const qty = Math.max(0, Math.min(byRisk, byNotional));

  return {
    qty,
    riskAmount: round2(qty * stopDistance),
    notional: round2(qty * entryPrice),
  };
}

export interface ValidationInput {
  market: Market;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  target: number;
  sector: string;
  equity: number;
  cash: number;
  openPositions: Position[];
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateProposal(input: ValidationInput): ValidationResult {
  const { market, symbol, direction, entryPrice, stopLoss, target, sector, equity, cash, openPositions } = input;

  if (market === "NSE" && direction === "short") {
    return { ok: false, reason: "NSE delivery does not permit short positions" };
  }

  if (openPositions.some((p) => p.symbol === symbol)) {
    return { ok: false, reason: `Book already holds ${symbol}` };
  }

  if (direction === "long" && !(stopLoss < entryPrice)) {
    return { ok: false, reason: "A long stop must sit below the entry price" };
  }
  if (direction === "short" && !(stopLoss > entryPrice)) {
    return { ok: false, reason: "A short stop must sit above the entry price" };
  }
  if (direction === "long" && !(target > entryPrice)) {
    return { ok: false, reason: "A long target must sit above the entry price" };
  }
  if (direction === "short" && !(target < entryPrice)) {
    return { ok: false, reason: "A short target must sit below the entry price" };
  }

  if (openPositions.length >= MAX_OPEN_POSITIONS) {
    return { ok: false, reason: `Book already holds ${MAX_OPEN_POSITIONS} open positions` };
  }

  const { qty, notional } = sizePosition({ equity, entryPrice, stopLoss, direction });
  if (qty === 0) {
    return { ok: false, reason: "Risk budget does not support a single share at this stop distance" };
  }

  const valueOf = (p: Position) => p.qty * p.entryPrice;
  const deployed = openPositions.reduce((sum, p) => sum + valueOf(p), 0);
  const sectorExposure = openPositions
    .filter((p) => p.sector === sector)
    .reduce((sum, p) => sum + valueOf(p), 0);

  if (sectorExposure + notional > equity * MAX_SECTOR_PCT) {
    return {
      ok: false,
      reason: `Sector ${sector} exposure would exceed ${MAX_SECTOR_PCT * 100}% of equity`,
    };
  }
  if (deployed + notional > equity * MAX_DEPLOYED_PCT) {
    return { ok: false, reason: `Deployed capital would exceed ${MAX_DEPLOYED_PCT * 100}% of equity` };
  }
  if (notional > cash) {
    return { ok: false, reason: "Insufficient cash to cover the position notional" };
  }

  return { ok: true };
}
