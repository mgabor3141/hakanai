// Container lifecycle for ephemeral conversations. Shells out to `docker` (the
// control plane runs as a container with the docker socket mounted, so this
// drives the host daemon).
//
// Topology (cross-conversation isolation; see scripts/isolation-smoke.sh and
// scripts/egress-smoke.sh):
//   - one --internal network PER conversation (hakanai-net-<id>): no route to
//     the internet, and not shared with any other conversation, so one agent
//     can never reach another.
//   - hakanai-egress (bridge): has internet. Only the proxy is on it.
//   - hakanai-proxy: CONNECT allowlist; the agent's ONLY way out. Joined to
//     every conversation network so each agent can reach it by name, but it
//     only forwards to allowlisted hosts, so it is not a pivot between agents.
//   - the control plane joins each conversation network to DIAL its agent, but
//     binds its HTTP/ws listener to the frontend interface only (see
//     frontendIp + server.ts), so agents cannot reach the control-plane API.
//
// Each conversation is one agent container: NO bind-mount, a disposable named
// volume at /work, no host-published port (reached by name on its own network),
// and HTTP(S)_PROXY pointed at the chokepoint.
import { $ } from "bun";

const IMAGE = process.env.AGENT_IMAGE ?? "hakanai-agent:dev";
const LABEL = "hakanai";
const AGENT_PORT = 7000;
const EGRESS = "hakanai-egress";
const PROXY = "hakanai-proxy";

// Per-conversation network name. Distinct from the agent container/volume name
// (hakanai-<id>) so the objects don't collide.
const convNet = (id: string) => `hakanai-net-${id}`;
// Extra comma-separated hosts the agent may reach, on top of the model endpoint
// (which is derived from HAKANAI_MODEL_BASE_URL). Usually empty.
const EGRESS_ALLOW = process.env.EGRESS_ALLOW ?? "";

// The agent's only legitimate destination is the model endpoint. Derive its host
// from the configured base URL so the egress allowlist scopes itself. `.host`
// (not `.hostname`) carries the port iff the URL has a non-default one, e.g.
// `inference.example:8443` -> `inference.example:8443` but `inference.example`
// (on 443) -> `inference.example`. The proxy reads exactly this `host[:port]`
// form: a bare host pins port 443, a `host:port` entry pins that port -- so the
// agent can reach the model on its real port and nothing else.
function modelHost(): string {
  try {
    return new URL(process.env.HAKANAI_MODEL_BASE_URL ?? "").host;
  } catch {
    return "";
  }
}

const MODEL_ENV = ["HAKANAI_MODEL_BASE_URL", "HAKANAI_MODEL_API_KEY", "HAKANAI_MODEL"] as const;

// Per-agent resource limits (the single-machine memory budget; see
// docs/adr/0002-memory-budget.md). Memory is a generous backstop against one
// runaway, not the working budget, so heavy toolkit work (ffmpeg, libreoffice)
// does not trip it; swap is left at the default so the host rarely OOM-kills.
// pids-limit is the fork-bomb guard; cpus keeps one chat from pegging the
// machine. All overridable; revisit auto-derivation from total RAM later.
const AGENT_MEMORY = process.env.HAKANAI_AGENT_MEMORY ?? "4g";
const AGENT_PIDS = process.env.HAKANAI_AGENT_PIDS ?? "512";
const AGENT_CPUS = process.env.HAKANAI_AGENT_CPUS ?? "2";

export type Conv = { id: string; agentUrl: string; createdAt: number };

const name = (id: string) => `hakanai-${id}`;

// Idempotent: create the egress network and (re)run the egress proxy. Per
// conversation networks are created on demand in spawnAgent. Safe to call on
// every boot (the control plane boots at `up`, before any agents exist).
export async function ensureInfra(): Promise<void> {
  await $`docker network create ${EGRESS}`.nothrow().quiet();

  // Always (re)create the proxy so its allowlist tracks current config.
  const allow = [EGRESS_ALLOW, modelHost()].filter(Boolean).join(",");
  await $`docker rm -f ${PROXY}`.nothrow().quiet();
  await $`docker run -d --name ${PROXY} --network ${EGRESS} \
    -e ALLOW=${allow} -e PORT=8888 hakanai-egress:dev`.quiet();
}

// The control plane's own container id (its hostname inside docker).
async function selfName(): Promise<string> {
  return (await $`hostname`.text()).trim();
}

// The control plane's IP on the frontend (compose default) network, where the
// published port is delivered. The HTTP/ws listener binds here ONLY, so it is
// not reachable on any conversation network the control plane later joins to
// dial agents. Returns "" off-container (dev), where binding is moot.
export async function frontendIp(): Promise<string> {
  try {
    const info = await $`docker inspect ${await selfName()}`.json();
    const nets = info[0]?.NetworkSettings?.Networks as Record<string, { IPAddress?: string }> | undefined;
    if (!nets) return "";
    // At boot the control plane is attached only to the compose default bridge.
    const def = Object.entries(nets).find(([n]) => n.endsWith("_default"));
    return (def?.[1]?.IPAddress || Object.values(nets)[0]?.IPAddress) ?? "";
  } catch {
    return "";
  }
}

export async function spawnAgent(): Promise<Conv> {
  const id = crypto.randomUUID().slice(0, 8);
  const n = name(id);
  // Inject model auth as env vars (the agent bakes none). bun's fetch routes
  // these through HTTPS_PROXY -> the egress chokepoint -> the model host only.
  const modelEnv = MODEL_ENV.flatMap((k) => ["-e", `${k}=${process.env[k] ?? ""}`]);
  const net = convNet(id);

  // This conversation's own isolated network. The proxy joins it (so the agent
  // can reach the chokepoint by name) and the control plane joins it (so it can
  // dial the agent by name); no other agent is ever on it.
  await $`docker network create --internal ${net}`.nothrow().quiet();
  await $`docker network connect ${net} ${PROXY}`.nothrow().quiet();

  await $`docker run -d --name ${n} \
    --label ${LABEL}=1 --label conv=${id} \
    --network ${net} \
    --memory ${AGENT_MEMORY} --pids-limit ${AGENT_PIDS} --cpus ${AGENT_CPUS} \
    -e HTTP_PROXY=http://${PROXY}:8888 -e HTTPS_PROXY=http://${PROXY}:8888 \
    ${modelEnv} \
    -v ${n}:/work \
    ${IMAGE}`.quiet();

  // Join the control plane so it can reach the agent by name, then wait.
  await $`docker network connect ${net} ${await selfName()}`.nothrow().quiet();
  await waitReady(n, AGENT_PORT);
  return { id, agentUrl: `ws://${n}:${AGENT_PORT}`, createdAt: await createdAt(n) };
}

// All conversations, running or stopped (-a). A stopped conversation is one the
// budget evicted to free RAM; it still exists (volume intact, history on disk)
// and resumes when reactivated, so it must stay in the list.
export async function listConversations(): Promise<Conv[]> {
  const out = (await $`docker ps -a --filter label=${LABEL}=1 --format {{.Names}}`.text()).trim();
  if (!out) return [];
  const convs: Conv[] = [];
  for (const n of out.split("\n")) {
    const id = n.replace(/^hakanai-/, "");
    convs.push({ id, agentUrl: `ws://${n}:${AGENT_PORT}`, createdAt: await createdAt(n) });
  }
  return convs;
}

// Ids of conversations whose container is currently running (consuming RAM).
export async function listRunning(): Promise<string[]> {
  const out = (await $`docker ps --filter label=${LABEL}=1 --format {{.Names}}`.text()).trim();
  if (!out) return [];
  return out.split("\n").map((n) => n.replace(/^hakanai-/, ""));
}

// Stop a conversation's container to reclaim its RAM. The container and volume
// survive (unlike reap), so history resumes on the next startAgent. Any
// in-flight agent turn is interrupted.
export async function stopAgent(id: string): Promise<void> {
  // Short grace: we are interrupting on purpose and session history is written
  // to the volume incrementally, so we do not need the default 10s SIGTERM wait.
  await $`docker stop -t 3 ${name(id)}`.nothrow().quiet();
}

// Restart a previously stopped conversation and wait for its agent to listen.
// Network attachments (the conversation net, proxy, control plane) survive a
// stop, so this is just start + readiness.
export async function startAgent(id: string): Promise<void> {
  await $`docker start ${name(id)}`.quiet();
  await waitReady(name(id), AGENT_PORT);
}

// Whether a conversation's container is up right now.
export async function isRunning(id: string): Promise<boolean> {
  return (await listRunning()).includes(id);
}

// Whether the container's last exit was the kernel OOM killer (memory cap hit),
// so the UI can explain a sudden stop rather than show a bare disconnect.
export async function wasOOMKilled(id: string): Promise<boolean> {
  try {
    const info = await $`docker inspect ${name(id)}`.json();
    const state = info[0]?.State;
    return Boolean(state?.OOMKilled) || state?.ExitCode === 137;
  } catch {
    return false;
  }
}

// Where uploads land inside the conversation's disposable /work volume. The
// agent (cwd /work, ACP session cwd /work) gets an absolute path it can read.
// Files written here share the conversation's deletion boundary: destroying the
// container + volume destroys them too.
const UPLOAD_DIR = "/work/uploads";

function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 128) || "file";
}

// Copy an uploaded file into the conversation container's /work volume and
// return the in-container absolute path. Shells out to `docker cp` (the control
// plane already drives the daemon). The agent never receives the bytes over the
// model channel; it just gets a path to read locally.
export async function writeAttachment(id: string, filename: string, bytes: Uint8Array): Promise<string> {
  const n = name(id);
  const safe = `${crypto.randomUUID().slice(0, 8)}-${sanitizeFilename(filename)}`;
  const dest = `${UPLOAD_DIR}/${safe}`;
  const tmp = `/tmp/${safe}`;
  await Bun.write(tmp, bytes);
  try {
    await $`docker exec ${n} mkdir -p ${UPLOAD_DIR}`.quiet();
    await $`docker cp ${tmp} ${n}:${dest}`.quiet();
  } finally {
    await $`rm -f ${tmp}`.nothrow().quiet();
  }
  return dest;
}

// Copy a file back out of the conversation's /work volume so the browser can
// download it. Path is restricted to /work (the agent's writable space) so this
// cannot read the baked image's secrets (e.g. /root/.pi/agent/auth.json).
export async function exportFile(id: string, path: string): Promise<{ bytes: Uint8Array; name: string } | null> {
  if (!path.startsWith("/work/") || path.includes("..")) throw new Error("path not allowed");
  const n = name(id);
  const tmp = `/tmp/export-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await $`docker cp ${n}:${path} ${tmp}`.quiet();
  } catch {
    return null; // no such file
  }
  try {
    const file = Bun.file(tmp);
    if (!(await file.exists())) return null;
    return { bytes: new Uint8Array(await file.arrayBuffer()), name: path.split("/").pop() || "file" };
  } catch {
    return null; // a directory, or unreadable
  } finally {
    await $`rm -rf ${tmp}`.nothrow().quiet();
  }
}

export async function reapConversation(id: string): Promise<void> {
  const n = name(id);
  const net = convNet(id);
  await $`docker rm -f ${n}`.nothrow().quiet();
  await $`docker volume rm ${n}`.nothrow().quiet();
  // Detach the long-lived members so the network can be removed.
  await $`docker network disconnect -f ${net} ${PROXY}`.nothrow().quiet();
  await $`docker network disconnect -f ${net} ${await selfName()}`.nothrow().quiet();
  await $`docker network rm ${net}`.nothrow().quiet();
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
