// Proves the runtime Settings path end-to-end through the full stack:
//   1. Before any provider is configured, POST /api/conversations is refused
//      with 409 not_configured (the belt-and-suspenders server gate).
//   2. The model-discovery proxy's SSRF guard refuses the cloud metadata
//      address (169.254.169.254) -- creds-free.
//   3. With real OpenAI-compatible creds (sourced from .memory/oai-creds.env by
//      settings-smoke.sh), discover-models returns a non-empty catalog, the
//      provider is saved via POST /api/settings, a conversation spawns, and a
//      real completion streams back through the agent -> egress proxy ->
//      endpoint route (proving the OpenAI provider topology, not the sidecar).
//
// Steps 1-2 always run; step 3 runs only when creds are present, so this smoke
// is useful in a creds-free CI and exhaustive locally. Run with the stack up.
import { $ } from "bun";

const BASE = process.env.BASE ?? "http://127.0.0.1:8800";
const ORIGIN = process.env.ORIGIN ?? BASE;
const H = { Origin: ORIGIN, "Content-Type": "application/json" };
const die = (m: string): never => {
  console.error("FAIL:", m);
  process.exit(1);
};

// --- 1. unconfigured: spawn is refused ---
{
  const res = await fetch(`${BASE}/api/conversations`, { method: "POST", headers: H });
  if (res.status !== 409) die(`expected 409 before configuring, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  if (body.error !== "not_configured") die(`expected not_configured, got ${JSON.stringify(body)}`);
  console.log("OK: unconfigured appliance refuses to spawn (409 not_configured)");
}

// --- 2. SSRF guard refuses the metadata address ---
{
  const res = await fetch(`${BASE}/api/settings/discover-models`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ endpoint: "http://169.254.169.254/v1", token: "x" }),
  });
  if (res.status !== 400) die(`expected 400 for metadata endpoint, got ${res.status}`);
  const body = (await res.json()) as { error?: string };
  if (!/blocked address/.test(body.error ?? "")) die(`expected SSRF rejection, got ${JSON.stringify(body)}`);
  console.log("OK: discover-models SSRF guard rejects 169.254.169.254");
}

const endpoint = process.env.HAKANAI_MODEL_BASE_URL ?? "";
const token = process.env.HAKANAI_MODEL_API_KEY ?? "";
const wantModel = process.env.HAKANAI_MODEL ?? "";
if (!endpoint || !token) {
  console.log("SKIP: no OpenAI creds (.memory/oai-creds.env) -- creds-free checks passed");
  console.log("\nSETTINGS SMOKE OK (creds-free subset)");
  process.exit(0);
}

// --- 3a. discover models against the real endpoint ---
let model = wantModel;
{
  const res = await fetch(`${BASE}/api/settings/discover-models`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ endpoint, token }),
  });
  if (!res.ok) die(`discover-models failed: ${res.status} ${await res.text()}`);
  const { models } = (await res.json()) as { models: string[] };
  if (!models.length) die("discover-models returned an empty catalog");
  if (!model || !models.includes(model)) model = models[0];
  console.log(`OK: discover-models returned ${models.length} models (using "${model}")`);
}

// --- 3b. save the OpenAI provider ---
{
  const res = await fetch(`${BASE}/api/settings`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ provider: "openai", endpoint, token, model }),
  });
  if (!res.ok) die(`save settings failed: ${res.status} ${await res.text()}`);
  const pub = (await res.json()) as { provider: string; hasToken?: boolean };
  if (pub.provider !== "openai" || !pub.hasToken) die(`unexpected redacted settings: ${JSON.stringify(pub)}`);
  if (JSON.stringify(pub).includes(token)) die("redacted settings leaked the token!");
  console.log("OK: saved OpenAI provider (token redacted in the response)");
}

// --- 3c. spawn a conversation now that we are configured ---
const create = await fetch(`${BASE}/api/conversations`, { method: "POST", headers: H });
if (!create.ok) die(`create after configuring -> ${create.status}`);
const { id } = (await create.json()) as { id: string };
console.log("conversation:", id);

// --- 3d. real completion through agent -> proxy -> endpoint ---
const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/conversations/${id}/ws`, { headers: { Origin: ORIGIN } } as any);
await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res());
  ws.addEventListener("error", () => rej(new Error("ws open failed")));
});

let nextId = 1;
const pending = new Map<number, (m: any) => void>();
let text = "";
const handle = (m: any) => {
  if (typeof m.id === "number" && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
  }
  if (m.method === "session/update") {
    const c = m.params?.update?.content;
    if (c && typeof c === "object" && typeof (c as any).text === "string") text += (c as any).text;
  }
};
ws.addEventListener("message", (ev) => {
  // Each ws frame from stdio-to-ws is one JSON value (the "connected" envelope
  // then newline-delimited JSON-RPC); parse per message, tolerating the rare
  // multi-frame chunk by splitting on newlines as a fallback.
  const raw = String(ev.data).trim();
  if (!raw) return;
  try {
    handle(JSON.parse(raw));
  } catch {
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        handle(JSON.parse(s));
      } catch {}
    }
  }
});
const rpc = (method: string, params: any, timeoutMs = 60_000): Promise<any> =>
  new Promise((resolve, reject) => {
    const reqId = nextId++;
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(reqId, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n");
  });

await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
const ns = await rpc("session/new", { cwd: "/work", mcpServers: [] });
const sessionId = ns.result?.sessionId;
if (!sessionId) die("no sessionId from session/new");
const prompt = await rpc(
  "session/prompt",
  { sessionId, prompt: [{ type: "text", text: 'Reply with exactly the word: PONG' }] },
  90_000,
);
if (prompt.error) die(`prompt error: ${JSON.stringify(prompt.error)}`);
if (!text.trim()) die("no assistant text streamed back (completion did not reach the endpoint)");
console.log(`OK: real completion streamed back (${text.trim().length} chars): ${JSON.stringify(text.trim().slice(0, 60))}`);
ws.close();

await fetch(`${BASE}/api/conversations/${id}`, { method: "DELETE", headers: { Origin: ORIGIN } });
console.log("\nSETTINGS SMOKE OK -- OpenAI provider configured, agent completed a turn through the proxy");
