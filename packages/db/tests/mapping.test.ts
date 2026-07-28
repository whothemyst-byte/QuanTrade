import { describe, it, expect } from "vitest";
import { toPosition, fromPosition, toProposal, toBook, toBar } from "../src/mappers.js";

const row = {
  id: "11111111-1111-1111-1111-111111111111",
  proposal_id: "22222222-2222-2222-2222-222222222222",
  book_id: "us-main",
  symbol: "AAPL",
  sector: "Technology",
  direction: "long",
  qty: 50,
  entry_price: "100.1500",
  entry_date: "2026-07-28",
  stop_loss: "90.0000",
  target: "130.0000",
  max_hold_sessions: 8,
  entry_costs: "0.0000",
  status: "closed",
  is_shadow: false,
  exit_price: "129.8000",
  exit_date: "2026-08-05",
  exit_reason: "target",
  exit_costs: "0.5600",
  gross_pnl: "1482.5000",
  net_pnl: "1481.9400",
};

describe("toPosition", () => {
  it("converts numeric strings into numbers", () => {
    const p = toPosition(row);
    expect(p.entryPrice).toBe(100.15);
    expect(p.netPnl).toBe(1481.94);
    expect(typeof p.qty).toBe("number");
  });

  it("maps snake_case to camelCase", () => {
    const p = toPosition(row);
    expect(p.maxHoldSessions).toBe(8);
    expect(p.isShadow).toBe(false);
    expect(p.exitReason).toBe("target");
  });

  it("leaves optional exit fields undefined on an open position", () => {
    const open = {
      ...row, status: "open", exit_price: null, exit_date: null,
      exit_reason: null, exit_costs: null, gross_pnl: null, net_pnl: null,
    };
    const p = toPosition(open);
    expect(p.status).toBe("open");
    expect(p.exitPrice).toBeUndefined();
    expect(p.netPnl).toBeUndefined();
  });

  it("round-trips through fromPosition without loss", () => {
    const p = toPosition(row);
    const back = fromPosition(p);
    expect(back.entry_price).toBe(100.15);
    expect(back.max_hold_sessions).toBe(8);
    expect(back.symbol).toBe("AAPL");
    expect(back.net_pnl).toBe(1481.94);
  });

  it("never yields NaN from a null numeric", () => {
    const p = toPosition({ ...row, gross_pnl: null });
    expect(p.grossPnl).toBeUndefined();
    expect(Number.isNaN(p.grossPnl as number)).toBe(false);
  });

  it("throws rather than silently producing NaN from junk", () => {
    expect(() => toPosition({ ...row, entry_price: "not-a-number" })).toThrow(/numeric/i);
  });

  it("throws when a required numeric column is missing", () => {
    expect(() => toPosition({ ...row, qty: null })).toThrow(/qty/);
  });

  it("nulls every exit column when serialising an open position", () => {
    const open = toPosition({
      ...row, status: "open", exit_price: null, exit_date: null,
      exit_reason: null, exit_costs: null, gross_pnl: null, net_pnl: null,
    });
    const back = fromPosition(open);
    expect(back.exit_price).toBeNull();
    expect(back.exit_reason).toBeNull();
    expect(back.net_pnl).toBeNull();
  });
});

describe("toProposal", () => {
  it("maps the falsifier and rules array", () => {
    const p = toProposal({
      id: "33333333-3333-3333-3333-333333333333",
      run_id: "44444444-4444-4444-4444-444444444444",
      book_id: "us-main", symbol: "AAPL", direction: "long",
      conviction: "0.720", stop_loss: "90.0000", target: "130.0000",
      max_hold_sessions: 8, thesis: "t", rules_applied: ["R-001"],
      falsifier: "f", signals_snapshot: {}, status: "pending",
      engine_reject_reason: null,
    });
    expect(p.conviction).toBe(0.72);
    expect(p.rulesApplied).toEqual(["R-001"]);
    expect(p.whatWouldFalsifyThis).toBe("f");
    expect(p.engineRejectReason).toBeUndefined();
  });

  it("defaults a missing rules array to empty", () => {
    const p = toProposal({
      id: "x", run_id: "y", book_id: "us-main", symbol: "AAPL", direction: "long",
      conviction: "0.5", stop_loss: "90", target: "130", max_hold_sessions: 5,
      thesis: "t", rules_applied: null, falsifier: "f", status: "pending",
    });
    expect(p.rulesApplied).toEqual([]);
  });
});

describe("toBook and toBar", () => {
  it("maps a book row", () => {
    const b = toBook({
      id: "nse-main", market: "NSE", currency: "INR",
      starting_capital: "999999.0000", cash: "812345.6700",
    });
    expect(b.startingCapital).toBe(999999);
    expect(b.cash).toBe(812345.67);
  });

  it("maps a bar row and keeps volume an integer", () => {
    const bar = toBar({
      symbol: "TCS.NS", date: "2026-07-28",
      open: "3000.0000", high: "3050.0000", low: "2990.0000", close: "3040.0000",
      volume: 1234567,
    });
    expect(bar.close).toBe(3040);
    expect(bar.volume).toBe(1234567);
  });
});
