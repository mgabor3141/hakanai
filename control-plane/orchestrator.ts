// Container lifecycle for ephemeral conversations. Shells out to `docker` to
// keep the prototype dependency-free; a docker SDK can come later.
//
// Each conversation is one container with:
//   - NO bind-mount (the whole point: nothing leaks to the host filesystem)
//   - a disposable named volume at /work (the only place conversation data lives)
//   - the ws agent published to 127.0.0.1 on a random port (prototype; the real
//     design keeps containers on a private network the control plane joins)
//
// TODO(seam: egress) run on a `docker network create --internal` network with a
// Vertex-only allowlist proxy, so bash+curl inside has nowhere to exfiltrate to.
import { $ } from "bun";

const IMAGE = process.env.AGENT_IMAGE ?? "hako-ephemeral-agent:dev";
const LABEL = "hako-ephemeral";
const AGENT_PORT = 7000;

export type Conv = { id: string; agentUrl: string; createdAt: number };

const name = (id: string) => `hako-eph-${id}`;

export async function spawnAgent(): Promise<Conv> {
  const id = crypto.randomUUID().slice(0, 8);
  const n = name(id);
  await $`docker run -d --name ${n} \
    --label ${LABEL}=1 --label conv=${id} \
    -v ${n}:/work \
    -p 127.0.0.1:0:${AGENT_PORT} \
    ${IMAGE}`.quiet();
  const port = await mappedPort(n);
  await waitReady(port);
  return { id, agentUrl: `ws://127.0.0.1:${port}`, createdAt: Date.now() };
}

export async function listConversations(): Promise<Conv[]> {
  const out = (await $`docker ps --filter label=${LABEL}=1 --format {{.Names}}`.text()).trim();
  if (!out) return [];
  const convs: Conv[] = [];
  for (const n of out.split("\n")) {
    const id = n.replace(/^hako-eph-/, "");
    let port = 0;
    try {
      port = await mappedPort(n);
    } catch {}
    convs.push({ id, agentUrl: `ws://127.0.0.1:${port}`, createdAt: await createdAt(n) });
  }
  return convs;
}

export async function reapConversation(id: string): Promise<void> {
  const n = name(id);
  await $`docker rm -f ${n}`.nothrow().quiet();
  await $`docker volume rm ${n}`.nothrow().quiet();
}

async function mappedPort(n: string): Promise<number> {
  const out = (await $`docker port ${n} ${AGENT_PORT}/tcp`.text()).trim();
  const port = Number(out.split(":").pop());
  if (!port) throw new Error(`no port mapping for ${n}`);
  return port;
}

async function createdAt(n: string): Promise<number> {
  try {
    return new Date((await $`docker inspect -f {{.Created}} ${n}`.text()).trim()).getTime();
  } catch {
    return Date.now();
  }
}

// The container is up the moment `docker run` returns, but bun inside takes a
// few ms to start listening. Poll the published port before handing back a URL.
async function waitReady(port: number, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      s.end();
      return;
    } catch {
      await Bun.sleep(150);
    }
  }
  throw new Error(`agent on :${port} not ready`);
}
