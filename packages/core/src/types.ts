export type Market = "NSE" | "US";
export type Currency = "INR" | "USD";
export type Direction = "long" | "short";
export type Side = "buy" | "sell";

export type ExitReason = "stop" | "target" | "max_hold" | "forced";

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "engine_rejected";

export type PositionStatus = "open" | "closed";

/** A daily OHLCV bar. `date` is an ISO date string, `YYYY-MM-DD`, in the
 *  market's local timezone — never a timestamp, to avoid TZ drift. */
export interface Bar {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Book {
  id: string;
  market: Market;
  currency: Currency;
  startingCapital: number;
  cash: number;
}

export interface Proposal {
  id: string;
  bookId: string;
  symbol: string;
  direction: Direction;
  conviction: number;
  stopLoss: number;
  target: number;
  maxHoldSessions: number;
  thesis: string;
  rulesApplied: string[];
  whatWouldFalsifyThis: string;
  status: ProposalStatus;
  engineRejectReason?: string;
}

export interface CostBreakdown {
  brokerage: number;
  stt: number;
  stampDuty: number;
  exchangeFees: number;
  regulatoryFees: number;
  gst: number;
  total: number;
}

export interface Position {
  id: string;
  proposalId: string;
  bookId: string;
  symbol: string;
  sector: string;
  direction: Direction;
  qty: number;
  entryPrice: number;
  entryDate: string;
  stopLoss: number;
  target: number;
  maxHoldSessions: number;
  status: PositionStatus;
  isShadow: boolean;
  entryCosts: number;
  exitPrice?: number;
  exitDate?: string;
  exitReason?: ExitReason;
  exitCosts?: number;
  grossPnl?: number;
  netPnl?: number;
}

export interface EquitySnapshot {
  bookId: string;
  date: string;
  equity: number;
  cash: number;
  deployed: number;
}
