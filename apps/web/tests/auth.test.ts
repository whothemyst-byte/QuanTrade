import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isOwner, ownerEmails } from "../lib/auth";

const original = process.env.OWNER_EMAIL;
beforeEach(() => {
  process.env.OWNER_EMAIL = "madhu264m@gmail.com,mailtomadhu004@gmail.com";
});
afterEach(() => {
  process.env.OWNER_EMAIL = original;
});

describe("ownerEmails", () => {
  it("splits a comma-separated list and lowercases it", () => {
    process.env.OWNER_EMAIL = " A@Example.com , b@example.com ";
    expect(ownerEmails()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("returns an empty list when unset", () => {
    delete process.env.OWNER_EMAIL;
    expect(ownerEmails()).toEqual([]);
  });

  it("ignores empty entries from a trailing comma", () => {
    process.env.OWNER_EMAIL = "a@example.com,,";
    expect(ownerEmails()).toEqual(["a@example.com"]);
  });
});

describe("isOwner", () => {
  it("accepts either configured address", () => {
    expect(isOwner("madhu264m@gmail.com")).toBe(true);
    expect(isOwner("mailtomadhu004@gmail.com")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isOwner("MADHU264M@Gmail.COM")).toBe(true);
  });

  it("rejects any other address", () => {
    expect(isOwner("someone@else.com")).toBe(false);
  });

  it("rejects a missing email", () => {
    expect(isOwner(undefined)).toBe(false);
    expect(isOwner(null)).toBe(false);
    expect(isOwner("")).toBe(false);
  });

  it("locks everyone out when the allowlist is empty, rather than letting everyone in", () => {
    // The failure mode that matters: a missing env var must not open the app.
    delete process.env.OWNER_EMAIL;
    expect(isOwner("madhu264m@gmail.com")).toBe(false);
  });

  it("does not match a substring or a lookalike domain", () => {
    expect(isOwner("madhu264m@gmail.com.evil.com")).toBe(false);
    expect(isOwner("xmadhu264m@gmail.com")).toBe(false);
  });
});
