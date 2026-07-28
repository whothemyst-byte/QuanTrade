import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createNotifier, createNullNotifier, notifierFromEnv, escapeMarkdown,
} from "../src/notify/telegram.js";

afterEach(() => vi.unstubAllGlobals());

describe("createNotifier", () => {
  it("posts the message to the bot API", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", spy);

    await createNotifier("TOKEN", "CHAT")("hello");

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe("CHAT");
    expect(body.text).toBe("hello");
  });

  it("truncates messages beyond Telegram's 4096-character limit", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", spy);

    await createNotifier("T", "C")("x".repeat(5000));

    const body = JSON.parse((spy.mock.calls[0] as any)[1].body);
    expect(body.text).toHaveLength(4096);
  });

  it("swallows a delivery failure rather than failing the trading run", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createNotifier("T", "C")("hi")).resolves.toBeUndefined();
  });
});

describe("escapeMarkdown", () => {
  it("escapes characters that would break a ticker name", () => {
    expect(escapeMarkdown("BAJAJ_AUTO *hot*")).toBe("BAJAJ\\_AUTO \\*hot\\*");
  });
});

describe("createNullNotifier", () => {
  it("resolves without any network call", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await createNullNotifier()("hi");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("notifierFromEnv", () => {
  it("returns a real notifier when both secrets are present", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", spy);
    await notifierFromEnv({ TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "C" } as never)("x");
    expect(spy).toHaveBeenCalled();
  });

  it("falls back to the null notifier when secrets are missing", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await notifierFromEnv({} as never)("x");
    expect(spy).not.toHaveBeenCalled();
  });
});
