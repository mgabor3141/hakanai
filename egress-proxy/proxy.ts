// The egress chokepoint. The agent container sits on an `--internal` docker
// network with no route to the internet; its ONLY way out is this proxy, which
// straddles the internal net and a normal (internet) net and permits CONNECT
// tunnels to allowlisted hosts only. A bash + curl agent therefore has nowhere
// to exfiltrate: raw sockets have no route, and the proxy refuses anything off
// the list.
//
// CONNECT-only (HTTPS tunneling) on purpose: forces TLS and keeps the filter to
// a hostname check on the CONNECT target -- no TLS interception. In v1 the
// allowlist is just the Vertex endpoint.
import net from "node:net";

const PORT = Number(process.env.PORT ?? 8888);

// We only ever tunnel TLS: the proxy does no interception, so a hostname check
// on the CONNECT target is the whole filter, and a plaintext tunnel would let
// data leave unencrypted past it. 443 is the default; an allowlist entry may
// pin a different TLS port (e.g. a model endpoint on :8443).
const DEFAULT_PORT = 443;

// Each allowlist entry is `host` (implies port 443) or `host:port`. Host match
// keeps suffix semantics (exact or dot-subdomain); port must match exactly, so
// an allowlisted host is only reachable on its expected TLS port. The `host`
// form matches the URL().host that orchestrator.ts derives, which carries the
// port iff the model base URL has a non-default one -- keeping the two ends
// coherent.
type Rule = { host: string; port: number };
const ALLOW = (process.env.ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const RULES: Rule[] = ALLOW.map((a) => {
  const i = a.lastIndexOf(":");
  return i > 0 && /^\d+$/.test(a.slice(i + 1))
    ? { host: a.slice(0, i), port: Number(a.slice(i + 1)) }
    : { host: a, port: DEFAULT_PORT };
});
const allowed = (host: string, port: number) =>
  RULES.some((r) => r.port === port && (host === r.host || host.endsWith("." + r.host)));

// Cap the bytes we buffer while waiting for the CONNECT request line. A real
// one is tiny; anything larger is junk, so drop it (fail closed) rather than
// buffer without bound.
const MAX_REQLINE = 8192;

net
  .createServer((client) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const eol = buf.indexOf("\r\n");
      if (eol < 0) {
        // Request line not complete yet: wait for more, unless it is absurd.
        if (buf.length > MAX_REQLINE) {
          client.removeListener("data", onData);
          client.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
        }
        return;
      }
      // Full request line is in hand; stop buffering and parse it.
      client.removeListener("data", onData);
      const line = buf.slice(0, eol);
      const m = line.match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP/i);
      if (!m) return void client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      const host = m[1];
      const port = Number(m[2]);
      if (!allowed(host, port)) {
        console.log(`DENY  ${host}:${port}`);
        return void client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
      console.log(`ALLOW ${host}:${port}`);
      const up = net.connect(port, host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        up.pipe(client);
        client.pipe(up);
      });
      up.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      client.on("error", () => up.destroy());
      client.on("close", () => up.destroy());
    };
    client.on("data", onData);
    client.on("error", () => {});
  })
  .listen(PORT, () => console.log(`egress proxy :${PORT} allow=[${ALLOW.join(", ") || "none"}]`));
