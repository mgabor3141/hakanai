// Proves the REAL agent through the full topology: create a conversation, and
// over the control plane's ws proxy complete an ACP `initialize` handshake with
// pi-acp running inside the (internal-only, egress-locked) container.
//
// Creds-free: `initialize` is protocol-level. The model round-trip (session/new
// + prompt) additionally needs pi authenticated to Vertex.
//
// Run with the stack up (`./hakanai up`), then: bun scripts/acp-smoke.ts
import { $ } from "bun";

const BASE = process.env.BASE ?? "http://127.0.0.1:8800";
const die = (m: string): never => {
  console.error("FAIL:", m);
  process.exit(1);
};

const create = await fetch(`${BASE}/api/conversations`, { method: "POST" });
if (!create.ok) die(`create -> ${create.status}`);
const { id } = (await create.json()) as { id: string };
console.log("conversation:", id);

const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/conversations/${id}/ws`);
await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res());
  ws.addEventListener("error", () => rej(new Error("ws open failed")));
});

const result = await new Promise<any>((res, rej) => {
  const t = setTimeout(() => rej(new Error("no initialize result in 15s")), 15_000);
  ws.addEventListener("message", (ev) => {
    let m: any;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return; // stdio-to-ws "connected" envelope etc.
    }
    if (m.id === 0 && m.result) {
      clearTimeout(t);
      res(m.result);
    }
  });
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    }) + "\n",
  );
});

console.log("agent:", result.agentInfo?.name, result.agentInfo?.version);
console.log("authMethods:", (result.authMethods ?? []).map((a: any) => a.id).join(", "));
if (result.agentInfo?.name !== "pi-acp") die("initialize did not come from pi-acp");
ws.close();

const ports = (await $`docker port hakanai-${id}`.text().catch(() => "")).trim();
if (ports) die(`agent has host-published ports (should be internal-only): ${ports}`);
console.log("agent is internal-only (no host-published ports) OK");

await fetch(`${BASE}/api/conversations/${id}`, { method: "DELETE" });
console.log("\nACP SMOKE OK -- real pi-acp agent over ws, through the control plane");
