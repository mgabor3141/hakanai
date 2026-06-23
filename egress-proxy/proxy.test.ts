// Unit tests for the egress allowlist logic -- the security crux of the
// chokepoint (SECURITY.md guarantee #2). The end-to-end behaviour is proven by
// scripts/egress-smoke.sh; these cover the matching edge cases that integration
// can't cheaply reach (suffix bypass, port pinning, malformed config).
import { expect, test } from "bun:test";
import { allowed, parseRules } from "./proxy.ts";

test("a bare host implies the default TLS port 443", () => {
  expect(parseRules("example.com")).toEqual([{ host: "example.com", port: 443 }]);
});

test("host:port pins a non-default TLS port", () => {
  expect(parseRules("inference.example:8443")).toEqual([{ host: "inference.example", port: 8443 }]);
});

test("multiple entries parse independently, trimming whitespace and blanks", () => {
  expect(parseRules(" a.com , b.com:8443 ,, ")).toEqual([
    { host: "a.com", port: 443 },
    { host: "b.com", port: 8443 },
  ]);
});

test("exact host on the right port is allowed", () => {
  expect(allowed(parseRules("example.com"), "example.com", 443)).toBe(true);
});

test("a dot-subdomain of an allowed host is allowed", () => {
  expect(allowed(parseRules("example.com"), "api.example.com", 443)).toBe(true);
});

test("a sibling domain that merely ends with the name is NOT allowed (suffix bypass)", () => {
  // The classic footgun: endsWith without the dot would let this through.
  expect(allowed(parseRules("example.com"), "notexample.com", 443)).toBe(false);
  expect(allowed(parseRules("example.com"), "evil-example.com", 443)).toBe(false);
});

test("an unrelated host is denied", () => {
  expect(allowed(parseRules("example.com"), "example.org", 443)).toBe(false);
});

test("an allowed host on a non-allowed port is denied", () => {
  expect(allowed(parseRules("example.com"), "example.com", 8443)).toBe(false);
  expect(allowed(parseRules("example.com"), "example.com", 80)).toBe(false);
});

test("a host:port rule only matches that exact port", () => {
  const rules = parseRules("inference.example:8443");
  expect(allowed(rules, "inference.example", 8443)).toBe(true);
  expect(allowed(rules, "inference.example", 443)).toBe(false);
});

test("an empty allowlist denies everything (fail closed)", () => {
  expect(parseRules("")).toEqual([]);
  expect(allowed(parseRules(""), "example.com", 443)).toBe(false);
});
