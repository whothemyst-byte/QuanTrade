import { describe, it, expect } from "vitest";
import {
  isSessionDay, nextSessionDay, sessionsBetween, addSessions,
} from "../src/calendar.js";

describe("isSessionDay", () => {
  it("accepts an ordinary weekday", () => {
    expect(isSessionDay("NSE", "2026-07-28")).toBe(true);  // Tuesday
    expect(isSessionDay("US", "2026-07-28")).toBe(true);
  });

  it("rejects weekends", () => {
    expect(isSessionDay("NSE", "2026-08-01")).toBe(false); // Saturday
    expect(isSessionDay("NSE", "2026-08-02")).toBe(false); // Sunday
    expect(isSessionDay("US", "2026-08-01")).toBe(false);
  });

  it("rejects each market's own holidays independently", () => {
    // Independence Day: NSE closed, and it is a Saturday in 2026 anyway.
    expect(isSessionDay("NSE", "2026-08-15")).toBe(false);
    expect(isSessionDay("US", "2026-08-15")).toBe(false);
    // Thanksgiving: US closed, NSE open.
    expect(isSessionDay("US", "2026-11-26")).toBe(false);
    expect(isSessionDay("NSE", "2026-11-26")).toBe(true);
    // Republic Day: NSE closed, US open.
    expect(isSessionDay("NSE", "2026-01-26")).toBe(false);
    expect(isSessionDay("US", "2026-01-26")).toBe(true);
  });
});

describe("nextSessionDay", () => {
  it("returns the following weekday", () => {
    expect(nextSessionDay("US", "2026-07-28")).toBe("2026-07-29");
  });

  it("skips the weekend", () => {
    expect(nextSessionDay("US", "2026-07-31")).toBe("2026-08-03"); // Fri -> Mon
  });

  it("skips a holiday that follows a weekend", () => {
    // 2026-11-25 Wed -> 11-26 Thanksgiving -> 11-27 Fri is a session.
    expect(nextSessionDay("US", "2026-11-25")).toBe("2026-11-27");
  });

  it("is strictly forward-looking even from a non-session day", () => {
    expect(nextSessionDay("US", "2026-08-01")).toBe("2026-08-03");
  });
});

describe("sessionsBetween", () => {
  it("returns inclusive session days and excludes closures", () => {
    const days = sessionsBetween("US", "2026-11-23", "2026-11-27");
    expect(days).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"]);
  });

  it("returns an empty list when the range holds no sessions", () => {
    expect(sessionsBetween("US", "2026-08-01", "2026-08-02")).toEqual([]);
  });
});

describe("addSessions", () => {
  it("counts sessions, not calendar days", () => {
    expect(addSessions("US", "2026-07-30", 2)).toBe("2026-08-03"); // Thu +2 -> Mon
  });

  it("returns the same day when adding zero", () => {
    expect(addSessions("US", "2026-07-28", 0)).toBe("2026-07-28");
  });
});

describe("calendar staleness guard", () => {
  it("throws for a date beyond the reviewed horizon", () => {
    expect(() => isSessionDay("US", "2028-03-01")).toThrow(/calendar/i);
  });
});
