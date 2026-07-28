import { round2, type Bar, type Direction, type ExitReason, type Side } from "@quantrade/core";

/** 0.15% each way, both markets. See spec section 5.2. */
export const SLIPPAGE_RATE = 0.0015;

/** Slippage always moves against the trader: buys fill higher, sells lower. */
export function applySlippage(price: number, side: Side): number {
  const factor = side === "buy" ? 1 + SLIPPAGE_RATE : 1 - SLIPPAGE_RATE;
  return round2(price * factor);
}

/** Entries always fill at the session open. The caller is responsible for
 *  passing the *next* session's bar — never the bar the decision came from. */
export function resolveEntry(bar: Bar, direction: Direction): number {
  return applySlippage(bar.open, direction === "long" ? "buy" : "sell");
}

export interface ExitCheck {
  direction: Direction;
  stopLoss: number;
  target: number;
}

export interface ExitFill {
  price: number;
  reason: ExitReason;
}

/**
 * Resolve whether a session closes a position, and at what price.
 *
 * Evaluation order is deliberate and conservative:
 *   1. Gap through the stop   -> fill at the open (stops do not protect gaps)
 *   2. Stop touched           -> fill at the stop (wins any same-session tie)
 *   3. Gap through the target -> fill at the open
 *   4. Target touched         -> fill at the target
 *
 * Daily bars cannot tell us whether the high or the low came first, so the
 * unfavourable assumption is the only defensible one.
 */
export function resolveExit(bar: Bar, pos: ExitCheck): ExitFill | null {
  const exitSide: Side = pos.direction === "long" ? "sell" : "buy";
  const fill = (price: number, reason: ExitReason): ExitFill => ({
    price: applySlippage(price, exitSide),
    reason,
  });

  if (pos.direction === "long") {
    if (bar.open <= pos.stopLoss) return fill(bar.open, "stop");
    if (bar.low <= pos.stopLoss) return fill(pos.stopLoss, "stop");
    if (bar.open >= pos.target) return fill(bar.open, "target");
    if (bar.high >= pos.target) return fill(pos.target, "target");
    return null;
  }

  if (bar.open >= pos.stopLoss) return fill(bar.open, "stop");
  if (bar.high >= pos.stopLoss) return fill(pos.stopLoss, "stop");
  if (bar.open <= pos.target) return fill(bar.open, "target");
  if (bar.low <= pos.target) return fill(pos.target, "target");
  return null;
}
