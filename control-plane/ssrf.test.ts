import { expect, test } from "bun:test";
import { assertEndpointAllowed, isBlockedIp } from "./ssrf";

// These pin the SSRF policy from the settings-ui handoff: the control-plane
// model-discovery proxy must refuse endpoints that point at the host itself or
// the cloud metadata service, while still allowing public hosts and LAN
// RFC-1918 ranges (a colleague's vLLM box).

test("blocks loopback", () => {
  expect(isBlockedIp("127.0.0.1")).toBe(true);
  expect(isBlockedIp("127.1.2.3")).toBe(true);
  expect(isBlockedIp("::1")).toBe(true);
});

test("blocks link-local and the cloud metadata address", () => {
  expect(isBlockedIp("169.254.0.1")).toBe(true);
  expect(isBlockedIp("169.254.169.254")).toBe(true);
  expect(isBlockedIp("fe80::1")).toBe(true);
});

test("blocks the unspecified address", () => {
  expect(isBlockedIp("0.0.0.0")).toBe(true);
  expect(isBlockedIp("::")).toBe(true);
});

test("blocks IPv4-mapped loopback (::ffff:127.0.0.1)", () => {
  expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
});

test("allows public addresses", () => {
  expect(isBlockedIp("8.8.8.8")).toBe(false);
  expect(isBlockedIp("93.184.216.34")).toBe(false);
});

test("allows private RFC-1918 ranges (LAN vLLM)", () => {
  expect(isBlockedIp("10.0.0.5")).toBe(false);
  expect(isBlockedIp("192.168.1.10")).toBe(false);
  expect(isBlockedIp("172.16.5.5")).toBe(false);
});

test("assertEndpointAllowed rejects an IP-literal metadata endpoint", async () => {
  await expect(assertEndpointAllowed("http://169.254.169.254/v1")).rejects.toThrow(/blocked address/);
});

test("assertEndpointAllowed rejects a loopback literal", async () => {
  await expect(assertEndpointAllowed("http://127.0.0.1:8080/v1")).rejects.toThrow(/blocked address/);
});

test("assertEndpointAllowed rejects non-http schemes", async () => {
  await expect(assertEndpointAllowed("file:///etc/passwd")).rejects.toThrow(/http/);
  await expect(assertEndpointAllowed("ftp://example.com")).rejects.toThrow(/http/);
});

test("assertEndpointAllowed allows a public RFC-1918 literal endpoint", async () => {
  const u = await assertEndpointAllowed("http://192.168.1.50:8000/v1");
  expect(u.hostname).toBe("192.168.1.50");
});
