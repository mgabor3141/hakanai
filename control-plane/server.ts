// hakanai control plane: serves the chat UI, manages conversations, and
// proxies each browser websocket to its conversation's container. The browser
// never talks to a container directly; the control plane is the only thing on
// the (eventually private) agent network.
import {
  ensureInfra,
  exportFile,
  frontendIp,
  isRunning,
  listConversations,
  listRunning,
  reapConversation,
  spawnAgent,
  startAgent,
  stopAgent,
  stopAllAgents,
  wasOOMKilled,
  writeAttachment,
} from "./orchestrator";
import { mkdir, rename } from "node:fs/promises";
import { parseActivity, reconcileActivity, serializeActivity } from "./activity";
import { checkBrowserOrigin } from "./origin-guard";
import { mergeIncoming, modelDiscoveryUrl, redact, VERTEX_MODELS, type IncomingSettings } from "./settings";
import { adcConnected, loadSettings, saveSettings } from "./settings-store";
import { assertEndpointAllowed } from "./ssrf";
import { abortGoogleAuth, completeGoogleAuth, googleAuthStatus, startGoogleAuth } from "./google-auth";

const PORT = Number(process.env.PORT ?? 8800);
// Single-machine memory budget: at most this many agent containers run at once
// (see docs/adr/0002-memory-budget.md). Idle ones are stopped (not deleted) to
// make room; resuming one restarts its container and reloads history.
const MAX_ACTIVE = Math.max(1, Number(process.env.HAKANAI_MAX_ACTIVE ?? 2));
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);
const IDLE_TTL_MS = Number(process.env.IDLE_TTL_MS ?? 3 * 24 * 60 * 60 * 1000); // 3 days
const REAP_INTERVAL_MS = 60_000;
const STATE_DIR = process.env.HAKANAI_STATE_DIR ?? "/state";
const ACTIVITY_FILE = `${STATE_DIR}/activity.json`;

// Last-activity index for the idle reaper. Persisted to the state volume (see
// loadActivity/flushActivity) so a control plane restart, crash, or redeploy
// cannot reset the 3-day deletion clock. The in-memory map is the hot path; the
// file mirrors it: flushed immediately on discrete actions (create, open,
// upload, download, delete) and on each reaper tick (which captures streaming
// ws touches; losing under a minute of recency on a crash is fine for a 3-day clock).
const lastActivity = new Map<string, number>();
const touch = (id: string) => lastActivity.set(id, Date.now());

async function loadActivity(): Promise<void> {
  try {
    const f = Bun.file(ACTIVITY_FILE);
    if (!(await f.exists())) return;
    for (const [id, ts] of parseActivity(await f.text())) lastActivity.set(id, ts);
  } catch (e) {
    console.error("activity index load failed (starting fresh):", e);
  }
}

let flushing = false;
let flushQueued = false;
async function flushActivity(): Promise<void> {
  if (flushing) {
    flushQueued = true;
    return;
  }
  flushing = true;
  try {
    await mkdir(STATE_DIR, { recursive: true });
    const tmp = `${ACTIVITY_FILE}.tmp`;
    await Bun.write(tmp, serializeActivity(lastActivity));
    await rename(tmp, ACTIVITY_FILE); // atomic replace
  } catch (e) {
    console.error("activity index flush failed:", e);
  } finally {
    flushing = false;
    if (flushQueued) {
      flushQueued = false;
      void flushActivity();
    }
  }
}

// Conversation titles. pi names each session (see the auto-session-name agent
// extension) and reports it over ACP as the session title. Rather than open a
// second ACP connection (which would fight the browser over the agent's single
// stdio), we snoop the proxied agent->browser stream for session/list results.
const titles = new Map<string, string>();

// Per-conversation in-flight prompt ids, observed on the proxied ws. A
// conversation is "busy" while it has an unanswered session/prompt: the budget
// will not silently evict it; interrupting it needs explicit consent (force).
const promptsInFlight = new Map<string, Set<number>>();
const isBusy = (id: string): boolean => (promptsInFlight.get(id)?.size ?? 0) > 0;
function addPrompt(id: string, reqId: number): void {
  let s = promptsInFlight.get(id);
  if (!s) promptsInFlight.set(id, (s = new Set()));
  s.add(reqId);
}
function clearPrompt(id: string, reqId: number): void {
  promptsInFlight.get(id)?.delete(reqId);
}

// Make room for one more (or for `targetId` to run) within MAX_ACTIVE. Stops the
// least-recently-used IDLE conversation(s) first. If only busy ones remain and
// `force` is false, reports who would be interrupted instead of stopping it.
type SlotResult = { ok: true } | { ok: false; wouldInterrupt: { id: string; title: string | null } };
async function ensureSlot(targetId: string | null, force: boolean): Promise<SlotResult> {
  const running = await listRunning();
  const targetRunning = targetId != null && running.includes(targetId);
  let over = running.length + (targetRunning ? 0 : 1) - MAX_ACTIVE;
  if (over <= 0) return { ok: true };

  const candidates = running.filter((id) => id !== targetId);
  const lru = (ids: string[]) => [...ids].sort((a, b) => (lastActivity.get(a) ?? 0) - (lastActivity.get(b) ?? 0));
  const toStop: string[] = [];
  const idle = lru(candidates.filter((id) => !isBusy(id)));
  while (over > 0 && idle.length) (toStop.push(idle.shift()!), over--);
  if (over > 0) {
    const busyLru = lru(candidates.filter((id) => isBusy(id)));
    if (!force) return { ok: false, wouldInterrupt: { id: busyLru[0], title: titles.get(busyLru[0]) ?? null } };
    while (over > 0 && busyLru.length) (toStop.push(busyLru.shift()!), over--);
  }
  for (const id of toStop) await stopAgent(id);
  return { ok: true };
}

type WSData = { id: string; agentUrl: string };

// Egress network + proxy, before serving.
await ensureInfra();

// Durable deletion clock: load the persisted last-activity index, then
// reconcile with the containers that actually exist. A conversation present in
// docker but missing from the index (unknown to us) gets a full lease so we
// never delete data we have no record for; index entries with no container are
// pruned. A stale entry (idle past the TTL while we were down) is kept as-is, so
// the reaper deletes it promptly on the next tick.
await loadActivity();
reconcileActivity(
  lastActivity,
  (await listConversations()).map((c) => c.id),
  Date.now(),
);
await flushActivity();

// Bind the listener to the frontend (compose default) interface ONLY. The
// published port (127.0.0.1:8800) is delivered there, while the per-conversation
// networks the control plane joins to dial agents have no listener. This is what
// keeps a sandboxed agent from reaching the control-plane API. Falls back to all
// interfaces only off-container (dev), where there are no agents to wall off.
const BIND = (await frontendIp()) || "0.0.0.0";

const server = Bun.serve<WSData>({
  port: PORT,
  hostname: BIND,
  // Some requests evict (docker stop) then spawn a container, which can take
  // longer than the 10s default before the first byte.
  idleTimeout: 60,
  async fetch(req, server) {
    const p = new URL(req.url).pathname;

    const wsm = p.match(/^\/api\/conversations\/([\w-]+)\/ws$/);

    // Browser-origin guard (see origin-guard.ts / docs/adr/0004). The API has no
    // accounts, so this is what stops a hostile page in the user's own browser
    // from driving us (CSRF) or rebinding DNS to read transcripts. Run before
    // any routing so it covers reads, writes, static files, and the ws upgrade.
    const guard = checkBrowserOrigin(
      {
        method: req.method,
        host: req.headers.get("host"),
        origin: req.headers.get("origin"),
        isWebSocket: wsm != null,
      },
      PORT,
    );
    if (guard) return new Response(`forbidden: ${guard}`, { status: 403 });

    if (wsm) {
      const conv = (await listConversations()).find((c) => c.id === wsm[1]);
      if (!conv) return new Response("no such conversation", { status: 404 });
      // The client activates before connecting, but be robust: if the container
      // was evicted, make room and start it so the ws never opens onto a dead
      // upstream. force=1 is safe here -- opening the ws is the user's intent.
      try {
        await ensureSlot(conv.id, true);
        if (!(await isRunning(conv.id))) await startAgent(conv.id);
      } catch (e) {
        return new Response(`activate failed: ${(e as Error).message}`, { status: 503 });
      }
      if (server.upgrade(req, { data: { id: conv.id, agentUrl: conv.agentUrl } })) return;
      return new Response("upgrade failed", { status: 400 });
    }

    if (p === "/") return new Response(Bun.file(`${import.meta.dir}/public/dist/index.html`));
    if (!p.startsWith("/api/")) {
      const file = Bun.file(`${import.meta.dir}/public/dist${p}`);
      if (await file.exists()) return new Response(file);
    }

    if (p === "/api/config" && req.method === "GET") {
      // `configured` gates the UI empty state + "New conversation"; vertexModels
      // is the curated Gemini dropdown (Vertex has no /v1/models discovery).
      const configured = (await loadSettings()) != null;
      return Response.json({ maxActive: MAX_ACTIVE, configured, vertexModels: VERTEX_MODELS });
    }

    // ---- Settings (the global, runtime provider config) ----
    if (p === "/api/settings" && req.method === "GET") {
      return Response.json(redact(await loadSettings(), await adcConnected()));
    }
    if (p === "/api/settings" && req.method === "POST") {
      let body: IncomingSettings;
      try {
        body = (await req.json()) as IncomingSettings;
      } catch {
        return new Response("expected JSON", { status: 400 });
      }
      let next;
      try {
        next = mergeIncoming(await loadSettings(), body);
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
      await saveSettings(next);
      // Reconcile shared infra (recompute the egress allowlist; recreate the
      // sidecar) and stop all running agents -- the new config is applied at the
      // next spawn, so in-flight agents under the old config must stop. History
      // on /work survives; reopening re-spawns under the current config.
      try {
        await ensureInfra();
        await stopAllAgents();
      } catch (e) {
        console.error("settings reconcile failed:", e);
      }
      return Response.json(redact(next, await adcConnected()));
    }
    // Proxy the OpenAI-compatible model discovery so the token stays server-side
    // and CORS is moot. Uses the INLINE form values (not saved config), so it
    // doubles as a pre-save "test connection". SSRF-guarded.
    if (p === "/api/settings/discover-models" && req.method === "POST") {
      let body: { endpoint?: string; token?: string };
      try {
        body = (await req.json()) as { endpoint?: string; token?: string };
      } catch {
        return new Response("expected JSON", { status: 400 });
      }
      const endpoint = (body.endpoint ?? "").trim();
      const token = (body.token ?? "").trim();
      if (!endpoint) return Response.json({ error: "endpoint required" }, { status: 400 });
      // Match the save-time contract: the agent can only egress to an https
      // endpoint (the proxy tunnels TLS only), so reject http here too for early,
      // consistent feedback rather than letting discovery pass then save fail.
      if (!/^https:\/\//i.test(endpoint)) {
        return Response.json({ error: "endpoint must use https (the egress proxy tunnels TLS only)" }, { status: 400 });
      }
      try {
        await assertEndpointAllowed(endpoint);
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
      try {
        const res = await fetch(modelDiscoveryUrl(endpoint), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return Response.json({ error: `endpoint returned ${res.status}` }, { status: 502 });
        const data = (await res.json()) as { data?: { id?: string }[] };
        const models = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
        return Response.json({ models });
      } catch (e) {
        return Response.json({ error: `discovery failed: ${(e as Error).message}` }, { status: 502 });
      }
    }

    // ---- Vertex "Connect Google" (paste-the-code ADC flow) ----
    if (p === "/api/auth/google/start" && req.method === "POST") {
      try {
        const url = await startGoogleAuth();
        return Response.json({ url });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    }
    if (p === "/api/auth/google/complete" && req.method === "POST") {
      let body: { code?: string };
      try {
        body = (await req.json()) as { code?: string };
      } catch {
        return new Response("expected JSON", { status: 400 });
      }
      const code = (body.code ?? "").trim();
      if (!code) return Response.json({ error: "code required" }, { status: 400 });
      try {
        const phase = await completeGoogleAuth(code);
        if (phase === "connected") await ensureInfra(); // recreate the sidecar to pick up the ADC
        return Response.json(googleAuthStatus());
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
    }
    if (p === "/api/auth/google/status" && req.method === "GET") {
      return Response.json(googleAuthStatus());
    }
    if (p === "/api/auth/google/abort" && req.method === "POST") {
      await abortGoogleAuth();
      return Response.json({ ok: true });
    }
    if (p === "/api/conversations" && req.method === "GET") {
      const convs = await listConversations();
      const running = new Set(await listRunning());
      return Response.json(
        convs.map((c) => {
          const last = lastActivity.get(c.id) ?? c.createdAt;
          return {
            id: c.id,
            lastActivity: last,
            // When the idle reaper will destroy this conversation if untouched.
            // The clock is soft: any activity resets it, and it restarts if the
            // control plane restarts. The UI shows it approximately.
            // Persisted, so a control plane restart does not extend it. Any
            // activity (including opening the conversation) resets it.
            expiresAt: last + IDLE_TTL_MS,
            title: titles.get(c.id) ?? null,
            // Budget state: whether the container is loaded (consuming RAM) and
            // whether it is mid-turn. The UI shows "N of M running" and gates
            // switching when it would interrupt active work.
            running: running.has(c.id),
            busy: isBusy(c.id),
          };
        }),
      );
    }
    if (p === "/api/conversations" && req.method === "POST") {
      // Belt-and-suspenders gate: refuse to spawn before a provider is configured
      // (the UI also disables "New conversation" in the empty state).
      if ((await loadSettings()) == null) return Response.json({ error: "not_configured" }, { status: 409 });
      const force = new URL(req.url).searchParams.get("force") === "1";
      const slot = await ensureSlot(null, force);
      if (!slot.ok) return Response.json({ error: "at_capacity", wouldInterrupt: slot.wouldInterrupt }, { status: 409 });
      try {
        const conv = await spawnAgent();
        touch(conv.id);
        void flushActivity();
        return Response.json({ id: conv.id });
      } catch (e) {
        console.error("spawn failed:", e);
        return new Response(`spawn failed: ${(e as Error).message}`, { status: 500 });
      }
    }
    // Ensure a conversation is loaded (its container running), making room within
    // the budget first. 409 with { wouldInterrupt } when the only way to free a
    // slot is to interrupt a busy conversation and force=1 was not passed.
    const actm = p.match(/^\/api\/conversations\/([\w-]+)\/activate$/);
    if (actm && req.method === "POST") {
      const id = actm[1];
      if (!(await listConversations()).some((c) => c.id === id)) {
        return new Response("no such conversation", { status: 404 });
      }
      const force = new URL(req.url).searchParams.get("force") === "1";
      const slot = await ensureSlot(id, force);
      if (!slot.ok) return Response.json({ error: "at_capacity", wouldInterrupt: slot.wouldInterrupt }, { status: 409 });
      try {
        if (!(await isRunning(id))) await startAgent(id);
        touch(id);
        await flushActivity(); // opening resets the clock; persist it now
        return Response.json({ ok: true });
      } catch (e) {
        console.error("activate failed:", e);
        return new Response(`activate failed: ${(e as Error).message}`, { status: 500 });
      }
    }
    // Upload a file into the conversation container's /work volume. Returns the
    // in-container path; the browser passes it to the agent as an attachment.
    const am = p.match(/^\/api\/conversations\/([\w-]+)\/attachments$/);
    if (am && req.method === "POST") {
      const id = am[1];
      if (!(await listConversations()).some((c) => c.id === id)) {
        return new Response("no such conversation", { status: 404 });
      }
      let file: unknown;
      try {
        file = (await req.formData()).get("file");
      } catch {
        return new Response("expected multipart/form-data", { status: 400 });
      }
      if (!(file instanceof File)) return new Response("missing file field", { status: 400 });
      if (file.size > MAX_UPLOAD_BYTES) return new Response("file too large", { status: 413 });
      try {
        const path = await writeAttachment(id, file.name, new Uint8Array(await file.arrayBuffer()));
        touch(id);
        void flushActivity();
        return Response.json({ path });
      } catch (e) {
        console.error("attachment write failed:", e);
        return new Response(`attachment failed: ${(e as Error).message}`, { status: 500 });
      }
    }

    // Download a file the agent produced in /work. Streams it as an attachment.
    const fm = p.match(/^\/api\/conversations\/([\w-]+)\/files$/);
    if (fm && req.method === "GET") {
      const id = fm[1];
      if (!(await listConversations()).some((c) => c.id === id)) {
        return new Response("no such conversation", { status: 404 });
      }
      const path = new URL(req.url).searchParams.get("path") ?? "";
      if (!path.startsWith("/work/") || path.includes("..")) {
        return new Response("forbidden path", { status: 403 });
      }
      try {
        const f = await exportFile(id, path);
        if (!f) return new Response("not found", { status: 404 });
        touch(id);
        void flushActivity();
        return new Response(f.bytes, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${f.name.replace(/"/g, "")}"`,
          },
        });
      } catch (e) {
        return new Response(`export failed: ${(e as Error).message}`, { status: 400 });
      }
    }

    const dm = p.match(/^\/api\/conversations\/([\w-]+)$/);
    if (dm && req.method === "DELETE") {
      await reapConversation(dm[1]);
      lastActivity.delete(dm[1]);
      titles.delete(dm[1]);
      promptsInFlight.delete(dm[1]);
      void flushActivity();
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const up = new WebSocket(ws.data.agentUrl);
      const ready = new Promise<void>((res, rej) => {
        up.addEventListener("open", () => res());
        up.addEventListener("error", () => rej(new Error("upstream error")));
      });
      up.addEventListener("message", (ev) => {
        touch(ws.data.id);
        if (typeof ev.data === "string") {
          w.snoop = eachJsonFrame(w.snoop + ev.data, (m) => {
            handleTitle(ws.data.id, m, titles);
            // A prompt result/error ends that turn: the conversation is idle again.
            if (typeof m.id === "number" && ("result" in m || "error" in m)) clearPrompt(ws.data.id, m.id);
          });
        }
        ws.send(ev.data as string | ArrayBuffer);
      });
      // If the upstream drops because the kernel OOM-killed the container, tell
      // the browser plainly instead of leaving a bare disconnect.
      up.addEventListener("close", async () => {
        promptsInFlight.delete(ws.data.id);
        try {
          if (await wasOOMKilled(ws.data.id)) {
            ws.send(JSON.stringify({ type: "hakanai_error", code: "oom", message: "This chat ran out of memory and was stopped. Reopen it to continue." }));
          }
        } catch {}
        ws.close();
      });
      const w = ws as unknown as { up: WebSocket; ready: Promise<void>; snoop: string; snoopUp: string };
      w.up = up;
      w.ready = ready;
      w.snoop = "";
      w.snoopUp = "";
    },
    async message(ws, msg) {
      touch(ws.data.id);
      const w = ws as unknown as { up: WebSocket; ready: Promise<void>; snoopUp: string };
      if (typeof msg === "string") {
        w.snoopUp = eachJsonFrame(w.snoopUp + msg, (m) => {
          if (m.method === "session/prompt" && typeof m.id === "number") addPrompt(ws.data.id, m.id);
        });
      }
      try {
        await w.ready;
        w.up.send(msg);
      } catch {
        ws.close();
      }
    },
    close(ws) {
      // The browser left. Drop busy state so a lingering background turn does
      // not pin the container against eviction.
      promptsInFlight.delete(ws.data.id);
      try {
        (ws as unknown as { up?: WebSocket }).up?.close();
      } catch {}
    },
  },
});

// Idle reaper: the enforcement arm of the 3-day deletion promise.
setInterval(async () => {
  const now = Date.now();
  for (const c of await listConversations()) {
    const last = lastActivity.get(c.id) ?? c.createdAt;
    if (now - last > IDLE_TTL_MS) {
      console.log(`[reap] ${c.id} idle past ttl`);
      await reapConversation(c.id);
      lastActivity.delete(c.id);
    }
  }
  // Persist the tick's touches (and any reaper deletes) so they survive a restart.
  await flushActivity();
}, REAP_INTERVAL_MS);

console.log(`hakanai control plane: http://127.0.0.1:${server.port}`);

// Walk concatenated JSON-RPC frames out of a ws byte stream, invoking `cb` for
// each complete object and returning the unconsumed tail (frames can split
// across ws messages, so the caller carries the tail forward).
function eachJsonFrame(buf: string, cb: (obj: any) => void): string {
  let i = 0;
  while (i < buf.length) {
    while (i < buf.length && " \n\r\t".includes(buf[i])) i++;
    if (i >= buf.length) break;
    if (buf[i] !== "{") {
      i++;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    let done = false;
    for (; j < buf.length; j++) {
      const c = buf[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        j++;
        done = true;
        break;
      }
    }
    if (!done) return buf.slice(i); // incomplete trailing frame
    try {
      cb(JSON.parse(buf.slice(i, j)));
    } catch {}
    i = j;
  }
  return buf.slice(i);
}

// Record the most-recently-updated session's title from a snooped session/list
// result. pi names each session; we surface that as the conversation title.
function handleTitle(id: string, m: any, into: Map<string, string>): void {
  const sessions = (m as { result?: { sessions?: { title?: string; updatedAt?: string }[] } }).result?.sessions;
  if (!Array.isArray(sessions) || sessions.length === 0) return;
  const newest = [...sessions].sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))[0];
  const title = newest?.title?.trim();
  if (title) into.set(id, title);
}
