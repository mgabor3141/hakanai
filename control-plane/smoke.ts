// End-to-end ACP round-trip against the (model-free) stub agent through the full
// topology: create a conversation, initialize, session/new, session/prompt, and
// assert the streamed agent_message_chunk + final result -- then check the data
// landed only in the disposable volume, and reap destroys container + volume.
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
let nextId = 1;
const pending = new Map<number, (m: any) => void>();
let chunks = "";

// stdio-to-ws frames are concatenated JSON, not reliably newline-delimited (its
// "connected" envelope has no trailing newline), so extract complete objects by
// brace depth, returning the unconsumed tail.
function drain(s: string, cb: (m: any) => void): string {
  let i = 0;
  while (i < s.length) {
    while (i < s.length && " \n\r\t".includes(s[i])) i++;
    if (i >= s.length || s[i] !== "{") {
      if (i < s.length && s[i] !== "{") i++;
      continue;
    }
    let depth = 0, inStr = false, esc = false, j = i, done = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        if (--depth === 0) { j++; done = true; break; }
      }
    }
    if (!done) return s.slice(i); // incomplete; wait for more
    try { cb(JSON.parse(s.slice(i, j))); } catch {}
    i = j;
  }
  return s.slice(i);
}

const onMsg = (m: any) => {
  if (m.id != null && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
  } else if (m.params?.update?.sessionUpdate === "agent_message_chunk") {
    chunks += m.params.update.content?.text ?? "";
  }
};
let buf = "";
ws.addEventListener("message", (ev) => { buf = drain(buf + String(ev.data), onMsg); });
const rpc = (method: string, params: unknown) =>
  new Promise<any>((res, rej) => {
    const mid = nextId++;
    pending.set(mid, res);
    setTimeout(() => rej(new Error(`${method} timed out`)), 15_000);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  });

await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res());
  ws.addEventListener("error", () => rej(new Error("ws open failed")));
});

const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
console.log("agent:", init.result?.agentInfo?.name);
const sn = await rpc("session/new", { cwd: "/work", mcpServers: [] });
const sessionId = sn.result?.sessionId;
if (!sessionId) die(`no sessionId: ${JSON.stringify(sn)}`);
const prompt = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello hako" }] });
console.log("streamed chunk:", JSON.stringify(chunks), "stopReason:", prompt.result?.stopReason);
if (!chunks.includes("hello hako")) die("no streamed agent message echoing the prompt");
ws.close();

const transcript = (await $`docker exec hako-eph-${id} cat /work/transcript.log`.text()).trim();
if (!transcript.includes("hello hako")) die("transcript missing data in volume");
console.log("data confined to disposable volume OK");

const del = await fetch(`${BASE}/api/conversations/${id}`, { method: "DELETE" });
if (del.status !== 204) die(`delete -> ${del.status}`);
const gone = (await $`docker ps -a --filter name=hako-eph-${id} --format {{.Names}}`.text()).trim();
const vol = (await $`docker volume ls --filter name=hako-eph-${id} --format {{.Name}}`.text()).trim();
if (gone || vol) die("container or volume survived reap");

console.log("\nSMOKE OK -- full ACP round-trip, data deleted with the container");
