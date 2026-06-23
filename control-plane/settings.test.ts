import { expect, test } from "bun:test";
import { mergeIncoming, parseSettings, redact, serializeSettings, type Settings } from "./settings";

// These pin the runtime-settings decisions from the settings-ui handoff: the
// on-disk format, the write-only secret redaction (the token / ADC must NEVER
// leave the server), and preserve-on-blank for the openai token.

test("round-trips an openai config through serialize/parse", () => {
  const s: Settings = { provider: "openai", endpoint: "https://api.example/v1", token: "sk-secret", model: "gpt-x" };
  expect(parseSettings(serializeSettings(s))).toEqual(s);
});

test("round-trips a vertex config through serialize/parse", () => {
  const s: Settings = { provider: "vertex", project: "p", location: "us-central1", model: "gemini-2.5-pro" };
  expect(parseSettings(serializeSettings(s))).toEqual(s);
});

test("parse is tolerant: missing/corrupt/partial yields null (the appliance still boots)", () => {
  expect(parseSettings("not json")).toBeNull();
  expect(parseSettings("[]")).toBeNull();
  expect(parseSettings("null")).toBeNull();
  expect(parseSettings(JSON.stringify({ provider: "openai", endpoint: "", token: "", model: "" }))).toBeNull();
  expect(parseSettings(JSON.stringify({ provider: "vertex", project: "p" }))).toBeNull();
  expect(parseSettings(JSON.stringify({ provider: "mystery" }))).toBeNull();
});

test("redact strips the openai token, keeping only a presence flag", () => {
  const s: Settings = { provider: "openai", endpoint: "https://api.example/v1", token: "sk-secret", model: "gpt-x" };
  const pub = redact(s, false);
  expect(pub).toEqual({ provider: "openai", endpoint: "https://api.example/v1", model: "gpt-x", hasToken: true });
  expect(JSON.stringify(pub)).not.toContain("sk-secret");
});

test("redact reports vertex connectivity without leaking credential bytes", () => {
  const s: Settings = { provider: "vertex", project: "p", location: "l", model: "m" };
  expect(redact(s, true)).toEqual({ provider: "vertex", project: "p", location: "l", model: "m", connected: true });
  expect(redact(s, false).provider === "vertex" && (redact(s, false) as any).connected).toBe(false);
});

test("redact of an unconfigured appliance is provider:none", () => {
  expect(redact(null, false)).toEqual({ provider: "none" });
});

test("preserve-on-blank: an empty openai token keeps the stored one", () => {
  const existing: Settings = { provider: "openai", endpoint: "https://old/v1", token: "sk-old", model: "m" };
  const merged = mergeIncoming(existing, { provider: "openai", endpoint: "https://new/v1", token: "", model: "m2" });
  expect(merged).toEqual({ provider: "openai", endpoint: "https://new/v1", token: "sk-old", model: "m2" });
});

test("a non-empty openai token replaces the stored one", () => {
  const existing: Settings = { provider: "openai", endpoint: "https://old/v1", token: "sk-old", model: "m" };
  const merged = mergeIncoming(existing, { provider: "openai", endpoint: "https://old/v1", token: "sk-new", model: "m" });
  expect((merged as any).token).toBe("sk-new");
});

test("switching to openai with a blank token is rejected (nothing to preserve)", () => {
  const existing: Settings = { provider: "vertex", project: "p", location: "l", model: "m" };
  expect(() => mergeIncoming(existing, { provider: "openai", endpoint: "https://e/v1", token: "", model: "m" })).toThrow(/token required/);
});

test("mergeIncoming rejects missing required fields", () => {
  expect(() => mergeIncoming(null, { provider: "openai", endpoint: "", token: "t", model: "m" })).toThrow(/endpoint/);
  expect(() => mergeIncoming(null, { provider: "vertex", project: "p", location: "", model: "m" })).toThrow(/location/);
});
