import { describe, it, expect } from "vitest";
import { round2 } from "../src/money.js";

describe("round2", () => {
  it("rounds to two decimal places", () => {
    expect(round2(10.005)).toBe(10.01);
    expect(round2(10.004)).toBe(10.0);
    expect(round2(2.675)).toBe(2.68);
  });

  it("survives float representation error", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005 * 100) / 100).toBe(1.005);
  });

  it("handles negatives symmetrically", () => {
    expect(round2(-2.675)).toBe(-2.68);
    expect(round2(-10.004)).toBe(-10.0);
  });

  it("passes through integers and zero", () => {
    expect(round2(0)).toBe(0);
    expect(round2(999999)).toBe(999999);
  });
});
