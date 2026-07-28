import { describe, it, expect } from "vitest";
import { universeFor, sectorMap, sectorOf, SECTORS } from "../src/universe.js";

describe("universe integrity", () => {
  it("holds roughly 100 instruments per market", () => {
    expect(universeFor("US").length).toBeGreaterThanOrEqual(90);
    expect(universeFor("NSE").length).toBeGreaterThanOrEqual(90);
  });

  it("has no duplicate symbols within a market", () => {
    for (const market of ["US", "NSE"] as const) {
      const symbols = universeFor(market).map((i) => i.symbol);
      expect(new Set(symbols).size).toBe(symbols.length);
    }
  });

  it("suffixes every NSE symbol with .NS and no US symbol with a dot", () => {
    for (const i of universeFor("NSE")) expect(i.symbol).toMatch(/\.NS$/);
    for (const i of universeFor("US")) expect(i.symbol).not.toContain(".");
  });

  it("draws every sector from the one shared vocabulary", () => {
    // A mismatch here silently defeats the 25% sector cap in the engine.
    for (const market of ["US", "NSE"] as const) {
      for (const i of universeFor(market)) {
        expect(SECTORS).toContain(i.sector as never);
      }
    }
  });

  it("gives every instrument a non-empty name", () => {
    for (const market of ["US", "NSE"] as const) {
      for (const i of universeFor(market)) expect(i.name.length).toBeGreaterThan(0);
    }
  });

  it("spreads each market across at least six sectors", () => {
    // A universe concentrated in two sectors would make the 25% cap
    // permanently binding and starve the agent of choices.
    for (const market of ["US", "NSE"] as const) {
      const distinct = new Set(universeFor(market).map((i) => i.sector));
      expect(distinct.size).toBeGreaterThanOrEqual(6);
    }
  });

  it("keeps every sector under 40% of its market, so the cap stays reachable", () => {
    for (const market of ["US", "NSE"] as const) {
      const all = universeFor(market);
      const counts = new Map<string, number>();
      for (const i of all) counts.set(i.sector, (counts.get(i.sector) ?? 0) + 1);
      for (const [sector, n] of counts) {
        expect({ sector, share: n / all.length }).toMatchObject({
          share: expect.any(Number),
        });
        expect(n / all.length).toBeLessThan(0.4);
      }
    }
  });
});

describe("sector lookup", () => {
  it("resolves a known symbol", () => {
    expect(sectorOf("US", "AAPL")).toBe("Technology");
    expect(sectorOf("NSE", "RELIANCE.NS")).toBe("Energy");
  });

  it("returns undefined for an unknown symbol", () => {
    expect(sectorOf("US", "NOTREAL")).toBeUndefined();
  });

  it("builds a complete symbol-to-sector map", () => {
    const map = sectorMap("NSE");
    expect(Object.keys(map)).toHaveLength(universeFor("NSE").length);
    expect(map["TCS.NS"]).toBe("Technology");
  });
});
