// hakanai control plane: serves the chat UI, manages conversations, and
// proxies each browser websocket to its conversation's container. The browser
// never talks to a container directly; the control plane is the only thing on
// the (eventually private) agent network.
import { ensureInfra, exportFile, listConversations, reapConversation, spawnAgent, writeAttachment } from "./orchestrator";

const PORT = Number(process.env.PORT ?? 8800);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);
const IDLE_TTL_MS = Number(process.env.IDLE_TTL_MS ?? 3 * 24 * 60 * 60 * 1000); // 3 days
const REAP_INTERVAL_MS = 60_000;

// Prototype activity index. The real index is rebuilt from docker labels on
// boot; this just tracks last-activity for the idle reaper.
const lastActivity = new Map<string, number>();
const touch = (id: string) => lastActivity.set(id, Date.now());

// Conversation titles. pi names each session (see the auto-session-name agent
// extension) and reports it over ACP as the session title. Rather than open a
// second ACP connection (which would fight the browser over the agent's single
// stdio), we snoop the proxied agent->browser stream for session/list results.
const titles = new Map<string, string>();

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
        convs.map((c) => {
          const last = lastActivity.get(c.id) ?? c.createdAt;
          return {
            id: c.id,
            lastActivity: last,
            // When the idle reaper will destroy this conversation if untouched.
            // The clock is soft: any activity resets it, and it restarts if the
            // control plane restarts. The UI shows it approximately.
            expiresAt: last + IDLE_TTL_MS,
            title: titles.get(c.id) ?? null,
          };
        }),
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
          w.snoop = snoopTitle(ws.data.id, w.snoop + ev.data, titles);
        }
        ws.send(ev.data as string | ArrayBuffer);
      });
      up.addEventListener("close", () => ws.close());
      const w = ws as unknown as { up: WebSocket; ready: Promise<void>; snoop: string };
      w.up = up;
      w.ready = ready;
      w.snoop = "";
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

// Scan concatenated JSON-RPC frames for a session/list result and record the
// most-recently-updated session's title for this conversation. Returns the
// unconsumed tail of the buffer (frames can split across ws messages).
function snoopTitle(id: string, buf: string, into: Map<string, string>): string {
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
      const m = JSON.parse(buf.slice(i, j)) as { result?: { sessions?: { title?: string; updatedAt?: string }[] } };
      const sessions = m.result?.sessions;
      if (Array.isArray(sessions) && sessions.length > 0) {
        const newest = [...sessions].sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))[0];
        const title = newest?.title?.trim();
        if (title) into.set(id, title);
      }
    } catch {}
    i = j;
  }
  return buf.slice(i);
}
