// SSRF guard for the model-discovery proxy (POST /api/settings/discover-models)
// and any control-plane fetch to a user-supplied endpoint. The browser cannot
// fetch {endpoint}/v1/models itself (CORS + we keep the token server-side), so
// the control plane makes the request -- which turns it into a confused deputy
// unless we refuse endpoints that point back at our own host or the cloud
// metadata service.
//
// Policy (settled in the handoff): reject loopback / link-local / metadata
// (127.0.0.0/8, 169.254.0.0/16 incl. 169.254.169.254, ::1, and unspecified
// 0.0.0.0/::). ALLOW private RFC-1918 ranges -- a colleague may run a LAN vLLM;
// we only block the host-local + link-local surface.
//
// The IP-range classification is pure (isBlockedIp) so it is unit-tested
// directly; assertEndpointAllowed adds the DNS resolution + URL parsing around
// it.
import { lookup } from "node:dns/promises";

// Parse an IPv4 dotted quad into its four octets, or null if not IPv4.
function ipv4Octets(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

// True when `ip` is in a range we must never let the control plane dial on a
// user's behalf: loopback, link-local (incl. the cloud metadata address), or
// the unspecified address. RFC-1918 private ranges are intentionally allowed.
// Accepts both IPv4 and (normalized) IPv6 literals.
export function isBlockedIp(ip: string): boolean {
  const v4 = ipv4Octets(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
    if (a === 0) return true; // 0.0.0.0/8 unspecified / "this host"
    return false;
  }
  // IPv6 (and IPv4-mapped IPv6). Lowercase, strip any zone id.
  const v6 = ip.toLowerCase().split("%")[0];
  if (v6 === "::1") return true; // loopback
  if (v6 === "::" || v6 === "::0") return true; // unspecified
  if (v6.startsWith("fe80")) return true; // link-local
  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible: classify the embedded v4.
  const mapped = /(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
  if (mapped) return isBlockedIp(mapped[1]);
  return false;
}

// Validate a user-supplied endpoint URL before the control plane fetches it.
// Rejects non-http(s) schemes and any endpoint whose hostname resolves to a
// blocked address. Throws with a short reason (the caller answers 400). Returns
// the parsed URL on success.
export async function assertEndpointAllowed(endpoint: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error("invalid endpoint URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("endpoint must be http(s)");
  }
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  // If it is already an IP literal, classify it directly (no DNS).
  if (ipv4Octets(host) || host.includes(":")) {
    if (isBlockedIp(host)) throw new Error(`endpoint resolves to a blocked address: ${host}`);
    return u;
  }
  // Resolve ALL addresses and reject if ANY is blocked (a name could resolve to
  // both a public and a loopback address; the strict choice is to refuse).
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`endpoint host does not resolve: ${host}`);
  }
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error(`endpoint resolves to a blocked address: ${address}`);
  }
  return u;
}
