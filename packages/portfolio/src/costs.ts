import { round2, type CostBreakdown, type Market, type Side } from "@quantrade/core";

/** Statutory rates as fractions of turnover. Reviewed against the exchange
 *  and regulator schedules; see docs/specs for the source table. */
const NSE = {
  brokerage: 0,        // discount broker, delivery segment
  stt: 0.001,          // 0.1%, both sides for delivery
  stampDuty: 0.00015,  // 0.015%, buy side only
  exchange: 0.0000297, // 0.00297%
  sebi: 0.000001,      // 0.0001%
  gst: 0.18,           // on brokerage + exchange + sebi
} as const;

const US = {
  sec: 0.0000278,      // 0.00278%, sell side only
  tafPerShare: 0.000166,
  tafCap: 8.3,
} as const;

const ZERO: CostBreakdown = {
  brokerage: 0, stt: 0, stampDuty: 0,
  exchangeFees: 0, regulatoryFees: 0, gst: 0, total: 0,
};

export function computeCosts(
  market: Market,
  side: Side,
  qty: number,
  price: number,
): CostBreakdown {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`Quantity must be a positive integer, received ${qty}`);
  }
  if (!(price > 0)) {
    throw new Error(`Price must be positive, received ${price}`);
  }

  const turnover = qty * price;

  if (market === "NSE") {
    const brokerage = round2(turnover * NSE.brokerage);
    const stt = round2(turnover * NSE.stt);
    const stampDuty = side === "buy" ? round2(turnover * NSE.stampDuty) : 0;
    const exchangeFees = round2(turnover * NSE.exchange);
    const regulatoryFees = round2(turnover * NSE.sebi);
    const gst = round2((brokerage + exchangeFees + regulatoryFees) * NSE.gst);
    return {
      brokerage, stt, stampDuty, exchangeFees, regulatoryFees, gst,
      total: round2(brokerage + stt + stampDuty + exchangeFees + regulatoryFees + gst),
    };
  }

  // US: buying is free; selling carries SEC and FINRA TAF.
  if (side === "buy") return { ...ZERO };

  const sec = turnover * US.sec;
  const taf = Math.min(qty * US.tafPerShare, US.tafCap);
  const regulatoryFees = round2(sec + taf);
  return { ...ZERO, regulatoryFees, total: regulatoryFees };
}
