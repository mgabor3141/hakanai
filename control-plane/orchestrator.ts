// Container lifecycle for ephemeral conversations. Shells out to `docker` (the
// control plane runs as a container with the docker socket mounted, so this
// drives the host daemon).
//
// Topology (proven in scripts/egress-smoke.sh):
//   - hakanai-internal (--internal): no route to the internet. Agents live here.
//   - hakanai-egress (bridge): has internet. Only the proxy is on both.
//   - hakanai-proxy: CONNECT allowlist; the agent's ONLY way out (v1: Vertex).
//   - the control plane joins hakanai-internal so it can reach agents by name.
//
// Each conversation is one agent container: NO bind-mount, a disposable named
// volume at /work, no host-published port (reached by name on the internal net),
// and HTTP(S)_PROXY pointed at the chokepoint.
import { $ } from "bun";

const IMAGE = process.env.AGENT_IMAGE ?? "hakanai-agent:dev";
const LABEL = "hakanai";
const AGENT_PORT = 7000;
const INTERNAL = "hakanai-internal";
const EGRESS = "hakanai-egress";
const PROXY = "hakanai-proxy";
// Comma-separated hosts the agent may reach (the Vertex endpoint). Empty = the
// agent has zero egress.
const EGRESS_ALLOW = process.env.EGRESS_ALLOW ?? "";

export type Conv = { id: string; agentUrl: string; createdAt: number };

const name = (id: string) => `hakanai-${id}`;

// Idempotent: create the networks, run the egress proxy, and join the control
// plane itself to the internal network. Safe to call on every boot.
export async function ensureInfra(): Promise<void> {
  await $`docker network create --internal ${INTERNAL}`.nothrow().quiet();
  await $`docker network create ${EGRESS}`.nothrow().quiet();

  const running = (await $`docker ps -q --filter name=^${PROXY}$`.text()).trim();
  if (!running) {
    await $`docker rm -f ${PROXY}`.nothrow().quiet();
    await $`docker run -d --name ${PROXY} --network ${EGRESS} \
      -e ALLOW=${EGRESS_ALLOW} -e PORT=8888 hakanai-egress:dev`.quiet();
    await $`docker network connect ${INTERNAL} ${PROXY}`.nothrow().quiet();
  }

  // Connect the control plane (this container) to the internal net so it can
  // reach agents by name. Best-effort: no-ops/!fails harmlessly off-container.
  const self = (await $`hostname`.text()).trim();
  await $`docker network connect ${INTERNAL} ${self}`.nothrow().quiet();
}

export async function spawnAgent(): Promise<Conv> {
  const id = crypto.randomUUID().slice(0, 8);
  const n = name(id);
  await $`docker run -d --name ${n} \
    --label ${LABEL}=1 --label conv=${id} \
    --network ${INTERNAL} \
    -e HTTP_PROXY=http://${PROXY}:8888 -e HTTPS_PROXY=http://${PROXY}:8888 \
    -v ${n}:/work \
    ${IMAGE}`.quiet();
  await waitReady(n, AGENT_PORT);
  return { id, agentUrl: `ws://${n}:${AGENT_PORT}`, createdAt: await createdAt(n) };
}

export async function listConversations(): Promise<Conv[]> {
  const out = (await $`docker ps --filter label=${LABEL}=1 --format {{.Names}}`.text()).trim();
  if (!out) return [];
  const convs: Conv[] = [];
  for (const n of out.split("\n")) {
    const id = n.replace(/^hakanai-/, "");
    convs.push({ id, agentUrl: `ws://${n}:${AGENT_PORT}`, createdAt: await createdAt(n) });
  }
  return convs;
}

export async function reapConversation(id: string): Promise<void> {
  const n = name(id);
  await $`docker rm -f ${n}`.nothrow().quiet();
  await $`docker volume rm ${n}`.nothrow().quiet();
}

async function createdAt(n: string): Promise<number> {
  try {
    return new Date((await $`docker inspect -f {{.Created}} ${n}`.text()).trim()).getTime();
  } catch {
    return Date.now();
  }
}

// The container is up the moment `docker run` returns, but bun inside takes a
// few ms to listen. Poll the agent (by name, on the internal net) before use.
async function waitReady(host: string, port: number, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const s = await Bun.connect({ hostname: host, port, socket: { data() {} } });
      s.end();
      return;
    } catch {
      await Bun.sleep(150);
    }
  }
  throw new Error(`agent ${host}:${port} not ready`);
}
