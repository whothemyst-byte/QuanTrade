import { describe, it, expect } from "vitest";
import { money, pct, signedPct, shortDate, minutesUntil, countdown, rewardToRisk } from "../lib/format";

describe("money", () => {
  it("formats INR with the rupee symbol and Indian grouping", () => {
    expect(money(999999, "INR")).toBe("₹9,99,999.00");
  });

  it("formats USD with the dollar symbol", () => {
    expect(money(999999, "USD")).toBe("$999,999.00");
  });

  it("keeps the sign on a loss", () => {
    expect(money(-1234.5, "USD")).toBe("-$1,234.50");
  });

  it("renders an em dash for null", () => {
    expect(money(null, "USD")).toBe("—");
  });
});

describe("pct and signedPct", () => {
  it("renders one decimal place", () => {
    expect(pct(12.345)).toBe("12.3%");
  });

  it("prefixes a plus on gains only", () => {
    expect(signedPct(2.5)).toBe("+2.5%");
    expect(signedPct(-2.5)).toBe("-2.5%");
    expect(signedPct(0)).toBe("0.0%");
  });

  it("renders an em dash for null rather than NaN", () => {
    expect(pct(null)).toBe("—");
    expect(signedPct(null)).toBe("—");
  });
});

describe("shortDate", () => {
  it("formats an ISO date without a timezone shift", () => {
    expect(shortDate("2026-07-28")).toBe("28 Jul 2026");
  });

  it("does not shift a date that would cross midnight UTC", () => {
    // The bug this guards: new Date("2026-01-01") is UTC midnight, which is
    // 31 Dec 2025 anywhere west of Greenwich.
    expect(shortDate("2026-01-01")).toBe("1 Jan 2026");
  });

  it("accepts a full timestamp and uses only the date part", () => {
    expect(shortDate("2026-07-28T13:45:00.000Z")).toBe("28 Jul 2026");
  });
});

describe("countdown", () => {
  const now = new Date("2026-07-28T10:00:00.000Z");

  it("reports minutes remaining under an hour", () => {
    expect(countdown("2026-07-28T10:45:00.000Z", now)).toBe("45m left");
  });

  it("reports hours and minutes beyond an hour", () => {
    expect(countdown("2026-07-28T12:30:00.000Z", now)).toBe("2h 30m left");
  });

  it("says expired once the deadline has passed", () => {
    expect(countdown("2026-07-28T09:00:00.000Z", now)).toBe("expired");
    expect(minutesUntil("2026-07-28T09:00:00.000Z", now)).toBe(0);
  });
});

describe("rewardToRisk", () => {
  it("computes the ratio around a reference price", () => {
    expect(rewardToRisk(100, 90, 130)).toBe(3);
  });

  it("works for a short", () => {
    expect(rewardToRisk(100, 110, 70)).toBe(3);
  });

  it("returns null when risk is zero", () => {
    expect(rewardToRisk(100, 100, 130)).toBeNull();
  });
});
