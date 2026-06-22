// hakanai control plane: serves the chat UI, manages conversations, and
// proxies each browser websocket to its conversation's container. The browser
// never talks to a container directly; the control plane is the only thing on
// the (eventually private) agent network.
import { ensureInfra, listConversations, reapConversation, spawnAgent } from "./orchestrator";

const PORT = Number(process.env.PORT ?? 8800);
const IDLE_TTL_MS = Number(process.env.IDLE_TTL_MS ?? 3 * 24 * 60 * 60 * 1000); // 3 days
const REAP_INTERVAL_MS = 60_000;

// Prototype activity index. The real index is rebuilt from docker labels on
// boot; this just tracks last-activity for the idle reaper.
const lastActivity = new Map<string, number>();
const touch = (id: string) => lastActivity.set(id, Date.now());

type WSData = { id: string; agentUrl: string };

// Networks + egress proxy + self-join the internal net, before serving.
await ensureInfra();

const server = Bun.serve<WSData>({
  port: PORT,
  // Bind all interfaces: in-container, docker delivers the host-published port on
  // eth0, not loopback. Host exposure is restricted by compose (127.0.0.1:8800).
  // TODO(seam: hardening) the control plane also sits on the internal agent net,
  // so this API is reachable by agents too -- bind the API off that net (agents
  // never need to reach the control plane; the control plane dials them).
  hostname: "0.0.0.0",
  async fetch(req, server) {
    const p = new URL(req.url).pathname;

    const wsm = p.match(/^\/api\/conversations\/([\w-]+)\/ws$/);
    if (wsm) {
      const conv = (await listConversations()).find((c) => c.id === wsm[1]);
      if (!conv) return new Response("no such conversation", { status: 404 });
      if (server.upgrade(req, { data: { id: conv.id, agentUrl: conv.agentUrl } })) return;
      return new Response("upgrade failed", { status: 400 });
    }

    if (p === "/") return new Response(Bun.file(`${import.meta.dir}/public/dist/index.html`));
    if (!p.startsWith("/api/")) {
      const file = Bun.file(`${import.meta.dir}/public/dist${p}`);
      if (await file.exists()) return new Response(file);
    }

    if (p === "/api/conversations" && req.method === "GET") {
      const convs = await listConversations();
      return Response.json(
        convs.map((c) => ({ id: c.id, lastActivity: lastActivity.get(c.id) ?? c.createdAt })),
      );
    }
    if (p === "/api/conversations" && req.method === "POST") {
      try {
        const conv = await spawnAgent();
        touch(conv.id);
        return Response.json({ id: conv.id });
      } catch (e) {
        console.error("spawn failed:", e);
        return new Response(`spawn failed: ${(e as Error).message}`, { status: 500 });
      }
    }
    const dm = p.match(/^\/api\/conversations\/([\w-]+)$/);
    if (dm && req.method === "DELETE") {
      await reapConversation(dm[1]);
      lastActivity.delete(dm[1]);
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
        ws.send(ev.data as string | ArrayBuffer);
      });
      up.addEventListener("close", () => ws.close());
      (ws as unknown as { up: WebSocket; ready: Promise<void> }).up = up;
      (ws as unknown as { up: WebSocket; ready: Promise<void> }).ready = ready;
    },
    async message(ws, msg) {
      touch(ws.data.id);
      const w = ws as unknown as { up: WebSocket; ready: Promise<void> };
      try {
        await w.ready;
        w.up.send(msg);
      } catch {
        ws.close();
      }
    },
    close(ws) {
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
}, REAP_INTERVAL_MS);

console.log(`hakanai control plane: http://127.0.0.1:${server.port}`);
