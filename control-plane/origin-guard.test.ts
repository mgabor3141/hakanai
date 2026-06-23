import { test, expect } from "bun:test";
import { allowedHosts, allowedOrigins, checkBrowserOrigin } from "./origin-guard";

// These pin the browser-origin guard decisions from ADR-0004: the appliance has
// no accounts, so a Host + Origin check is the whole defense against a hostile
// page in the user's own browser (CSRF + DNS rebinding). If someone loosens the
// policy, they change these on purpose.

const PORT = 8800;
const ok = (req: Parameters<typeof checkBrowserOrigin>[0]) => checkBrowserOrigin(req, PORT) === null;

test("the listener's loopback hosts and origins are accepted", () => {
  expect(allowedHosts(PORT)).toEqual(new Set(["127.0.0.1:8800", "localhost:8800", "[::1]:8800"]));
  expect(allowedOrigins(PORT)).toEqual(
    new Set(["http://127.0.0.1:8800", "http://localhost:8800", "http://[::1]:8800"]),
  );
});

test("legitimate same-origin requests from the UI are allowed", () => {
  // A GET read of the conversation list (no Origin needed).
  expect(ok({ method: "GET", host: "127.0.0.1:8800", origin: null })).toBe(true);
  // A state-changing POST carries the page's matching Origin.
  expect(ok({ method: "POST", host: "127.0.0.1:8800", origin: "http://127.0.0.1:8800" })).toBe(true);
  expect(ok({ method: "DELETE", host: "localhost:8800", origin: "http://localhost:8800" })).toBe(true);
  // The ws handshake (a GET) with a matching Origin.
  expect(ok({ method: "GET", host: "127.0.0.1:8800", origin: "http://127.0.0.1:8800", isWebSocket: true })).toBe(true);
});

test("a DNS-rebinding request is rejected on the Host header, any method", () => {
  // The page rebound evil.example to 127.0.0.1; the TCP lands here but the Host
  // (and Origin) name the attacker. Even a plain GET /files is rejected.
  expect(checkBrowserOrigin({ method: "GET", host: "evil.example:8800", origin: null }, PORT)).toMatch(/bad host/);
  expect(
    checkBrowserOrigin({ method: "GET", host: "evil.example:8800", origin: "http://evil.example:8800" }, PORT),
  ).toMatch(/bad host/);
  // ...and on the ws upgrade, which would otherwise leak transcripts.
  expect(
    checkBrowserOrigin({ method: "GET", host: "evil.example:8800", origin: "http://evil.example:8800", isWebSocket: true }, PORT),
  ).toMatch(/bad host/);
});

test("a missing Host is rejected (fail closed)", () => {
  expect(checkBrowserOrigin({ method: "GET", host: null, origin: null }, PORT)).toMatch(/bad host/);
});

test("a CSRF write from a hostile page (legit Host, foreign Origin) is rejected", () => {
  // The browser dials 127.0.0.1 directly, so Host is legitimate, but the Origin
  // is the attacker's page. This is the cross-site spawn/delete/upload case.
  expect(
    checkBrowserOrigin({ method: "POST", host: "127.0.0.1:8800", origin: "https://evil.example" }, PORT),
  ).toMatch(/bad origin/);
  expect(
    checkBrowserOrigin({ method: "DELETE", host: "127.0.0.1:8800", origin: "https://evil.example" }, PORT),
  ).toMatch(/bad origin/);
});

test("a state-changing request with no Origin at all is rejected (fail closed)", () => {
  // A form-POST or a non-browser client that omits Origin does not get a write.
  expect(checkBrowserOrigin({ method: "POST", host: "127.0.0.1:8800", origin: null }, PORT)).toMatch(/bad origin/);
});

test("a cross-site ws handshake with a foreign Origin is rejected", () => {
  expect(
    checkBrowserOrigin({ method: "GET", host: "127.0.0.1:8800", origin: "https://evil.example", isWebSocket: true }, PORT),
  ).toMatch(/bad origin/);
});

test("the wrong port is not one of our origins", () => {
  expect(checkBrowserOrigin({ method: "GET", host: "127.0.0.1:9999", origin: null }, PORT)).toMatch(/bad host/);
});
