import { describe, it, expect, vi } from "vitest";
import { askForProposals, extractJson, providersFromEnv } from "../src/llm/client.js";
import type { LlmProvider } from "../src/llm/client.js";

const VALID = JSON.stringify({
  market_view: "Quiet.",
  proposals: [{
    symbol: "AAPL", direction: "long", conviction: 0.6,
    stop_loss: 190, target: 230, max_hold_sessions: 7,
    thesis: "Reclaimed the 200-day.", rules_applied: [],
    what_would_falsify_this: "A close back below 190.",
  }],
});

function provider(name: string, texts: string[]): LlmProvider {
  const queue = [...texts];
  return {
    name,
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error(`${name} exhausted`);
      if (next === "THROW") throw new Error(`${name} is down`);
      return { text: next, tokens: 100 };
    }),
  };
}

describe("extractJson", () => {
  it("unwraps a fenced block", () => {
    expect(extractJson("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("pulls the object out of surrounding prose", () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toBe('{"a":1}');
  });

  it("passes bare JSON straight through", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
});

describe("askForProposals", () => {
  it("returns a parsed response from the primary", async () => {
    const r = await askForProposals([provider("groq", [VALID])], "s", "u");
    expect(r.model).toBe("groq");
    expect(r.response.proposals[0]?.symbol).toBe("AAPL");
    expect(r.tokens).toBe(100);
  });

  it("strips a markdown code fence before parsing", async () => {
    const fenced = "```json\n" + VALID + "\n```";
    const r = await askForProposals([provider("groq", [fenced])], "s", "u");
    expect(r.response.proposals).toHaveLength(1);
  });

  it("retries the same provider once with the validation error appended", async () => {
    const p = provider("groq", ["{ not json", VALID]);
    const r = await askForProposals([p], "s", "u");
    expect(r.response.proposals).toHaveLength(1);
    expect(p.complete).toHaveBeenCalledTimes(2);
    const secondUser = (p.complete as any).mock.calls[1][1] as string;
    expect(secondUser).toMatch(/previous response/i);
  });

  it("fails over to the next provider when the first throws", async () => {
    const r = await askForProposals([provider("groq", ["THROW"]), provider("gemini", [VALID])], "s", "u");
    expect(r.model).toBe("gemini");
  });

  it("does not waste a retry on a transport error", async () => {
    const groq = provider("groq", ["THROW", VALID]);
    const r = await askForProposals([groq, provider("gemini", [VALID])], "s", "u");
    expect(groq.complete).toHaveBeenCalledTimes(1);
    expect(r.model).toBe("gemini");
  });

  it("fails over when the first provider cannot produce valid JSON twice", async () => {
    const r = await askForProposals(
      [provider("groq", ["garbage", "still garbage"]), provider("gemini", [VALID])], "s", "u",
    );
    expect(r.model).toBe("gemini");
  });

  it("throws when every provider is exhausted", async () => {
    await expect(
      askForProposals([provider("groq", ["THROW"]), provider("gemini", ["THROW"])], "s", "u"),
    ).rejects.toThrow(/all providers failed/i);
  });

  it("rejects a schema-valid shape carrying an impossible proposal", async () => {
    // Long with a target below its stop — a contradiction the schema catches.
    const bad = JSON.stringify({
      market_view: "x",
      proposals: [{
        symbol: "AAPL", direction: "long", conviction: 0.6,
        stop_loss: 230, target: 190, max_hold_sessions: 7,
        thesis: "t", rules_applied: [], what_would_falsify_this: "f",
      }],
    });
    const r = await askForProposals(
      [provider("groq", [bad, bad]), provider("gemini", [VALID])], "s", "u",
    );
    expect(r.model).toBe("gemini");
  });

  it("accepts a valid stand-aside response", async () => {
    const aside = JSON.stringify({
      market_view: "Nothing worth risking capital on.",
      proposals: [],
      no_trade_reason: "No candidate cleared the volume filter.",
    });
    const r = await askForProposals([provider("groq", [aside])], "s", "u");
    expect(r.response.proposals).toHaveLength(0);
    expect(r.response.no_trade_reason).toMatch(/volume filter/);
  });
});

describe("providersFromEnv", () => {
  it("puts Groq first and Gemini second", () => {
    const p = providersFromEnv({ GROQ_API_KEY: "a", GEMINI_API_KEY: "b" } as never);
    expect(p.map((x) => x.name)).toEqual(["groq", "gemini"]);
  });

  it("works with only one key configured", () => {
    expect(providersFromEnv({ GEMINI_API_KEY: "b" } as never).map((x) => x.name)).toEqual(["gemini"]);
  });

  it("throws when no key is configured, rather than running blind", () => {
    expect(() => providersFromEnv({} as never)).toThrow(/no llm provider/i);
  });
});
