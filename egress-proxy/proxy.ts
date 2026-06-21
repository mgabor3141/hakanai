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
const ALLOW = (process.env.ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const allowed = (host: string) => ALLOW.some((a) => host === a || host.endsWith("." + a));

net
  .createServer((client) => {
    client.once("data", (chunk) => {
      const line = chunk.toString("latin1").split("\r\n")[0];
      const m = line.match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP/i);
      if (!m) return void client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      const host = m[1];
      const port = Number(m[2]);
      if (!allowed(host)) {
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
    });
    client.on("error", () => {});
  })
  .listen(PORT, () => console.log(`egress proxy :${PORT} allow=[${ALLOW.join(", ") || "none"}]`));
