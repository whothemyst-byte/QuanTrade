import { describe, it, expect } from "vitest";
import { BarSchema, AgentResponseSchema } from "../src/schemas.js";

const validProposal = {
  symbol: "RELIANCE.NS",
  direction: "long",
  conviction: 0.72,
  stop_loss: 2810,
  target: 3120,
  max_hold_sessions: 8,
  thesis: "Reclaimed the 200-day on above-average volume.",
  rules_applied: ["R-004"],
  what_would_falsify_this: "A close back below 2810.",
};

describe("BarSchema", () => {
  it("accepts a coherent bar", () => {
    expect(() =>
      BarSchema.parse({
        symbol: "AAPL", date: "2026-07-27",
        open: 100, high: 105, low: 99, close: 104, volume: 1000,
      }),
    ).not.toThrow();
  });

  it("rejects a high below the open or close", () => {
    expect(() =>
      BarSchema.parse({
        symbol: "AAPL", date: "2026-07-27",
        open: 100, high: 99, low: 98, close: 98.5, volume: 1000,
      }),
    ).toThrow(/high/i);
  });

  it("rejects a low above the open or close", () => {
    expect(() =>
      BarSchema.parse({
        symbol: "AAPL", date: "2026-07-27",
        open: 100, high: 105, low: 101, close: 104, volume: 1000,
      }),
    ).toThrow(/low/i);
  });

  it("rejects negative volume and malformed dates", () => {
    const base = { symbol: "AAPL", open: 100, high: 105, low: 99, close: 104 };
    expect(() => BarSchema.parse({ ...base, date: "2026-07-27", volume: -1 })).toThrow();
    expect(() => BarSchema.parse({ ...base, date: "27-07-2026", volume: 10 })).toThrow();
  });
});

describe("AgentResponseSchema", () => {
  it("accepts a well-formed response", () => {
    const parsed = AgentResponseSchema.parse({
      market_view: "Range-bound, low conviction.",
      proposals: [validProposal],
    });
    expect(parsed.proposals[0]?.symbol).toBe("RELIANCE.NS");
  });

  it("accepts standing aside with no proposals", () => {
    const parsed = AgentResponseSchema.parse({
      market_view: "Nothing worth risking capital on.",
      proposals: [],
      no_trade_reason: "No candidate cleared the volume filter.",
    });
    expect(parsed.proposals).toHaveLength(0);
  });

  it("rejects a proposal missing its stop", () => {
    const { stop_loss, ...noStop } = validProposal;
    void stop_loss;
    expect(() =>
      AgentResponseSchema.parse({ market_view: "x", proposals: [noStop] }),
    ).toThrow();
  });

  it("rejects conviction outside 0..1", () => {
    expect(() =>
      AgentResponseSchema.parse({
        market_view: "x",
        proposals: [{ ...validProposal, conviction: 1.4 }],
      }),
    ).toThrow();
  });

  it("rejects a long whose target sits below its stop", () => {
    expect(() =>
      AgentResponseSchema.parse({
        market_view: "x",
        proposals: [{ ...validProposal, target: 2700 }],
      }),
    ).toThrow(/target/i);
  });

  it("rejects an empty thesis", () => {
    expect(() =>
      AgentResponseSchema.parse({
        market_view: "x",
        proposals: [{ ...validProposal, thesis: "" }],
      }),
    ).toThrow();
  });
});
