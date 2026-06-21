// End-to-end tracer: create a conversation, round-trip a message through the
// ephemeral container, verify the container exists and wrote into its volume,
// then reap and verify both the container and the volume are gone.
import { $ } from "bun";

const BASE = process.env.BASE ?? "http://127.0.0.1:8800";
const die = (m: string): never => {
  console.error("FAIL:", m);
  process.exit(1);
};

const create = await fetch(`${BASE}/api/conversations`, { method: "POST" });
if (!create.ok) die(`create -> ${create.status}`);
const { id } = (await create.json()) as { id: string };
console.log("created conversation:", id);

const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/conversations/${id}/ws`);
await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res());
  ws.addEventListener("error", () => rej(new Error("ws open failed")));
});
const reply = await new Promise<string>((res, rej) => {
  const t = setTimeout(() => rej(new Error("no reply in 10s")), 10_000);
  ws.addEventListener("message", (ev) => {
    clearTimeout(t);
    res(String(ev.data));
  });
  ws.send(JSON.stringify({ text: "hello hako" }));
});
console.log("agent replied:", reply);
if (!reply.includes("hello hako")) die("echo mismatch");
ws.close();

const running = (await $`docker ps --filter name=hako-eph-${id} --format {{.Names}}`.text()).trim();
if (!running) die("container not running");
console.log("container running:", running);

const transcript = (await $`docker exec hako-eph-${id} cat /work/transcript.log`.text()).trim();
console.log("volume transcript:\n  " + transcript.replaceAll("\n", "\n  "));
if (!transcript.includes("hello hako")) die("transcript missing data");

const del = await fetch(`${BASE}/api/conversations/${id}`, { method: "DELETE" });
if (del.status !== 204) die(`delete -> ${del.status}`);
const gone = (await $`docker ps -a --filter name=hako-eph-${id} --format {{.Names}}`.text()).trim();
if (gone) die("container survived reap");
const vol = (await $`docker volume ls --filter name=hako-eph-${id} --format {{.Name}}`.text()).trim();
if (vol) die("volume survived reap");

console.log("reaped: container + volume gone");
console.log("\nSMOKE OK");
