// Container lifecycle for ephemeral conversations. Shells out to `docker` (the
// control plane runs as a container with the docker socket mounted, so this
// drives the host daemon).
//
// Topology (cross-conversation isolation; see scripts/isolation-smoke.sh and
// scripts/egress-smoke.sh):
//   - one --internal network PER conversation (hakanai-net-<id>): no route to
//     the internet, and not shared with any other conversation, so one agent
//     can never reach another.
//   - hakanai-egress (bridge): has internet. Only the proxy and the inference
//     sidecar are on it.
//   - hakanai-proxy: CONNECT allowlist; the ONLY route to the internet. Now
//     reached by the inference sidecar (not the agents), and forwards only to
//     the allowlisted Google endpoints, so it is not a pivot.
//   - hakanai-inference: the auth-injecting sidecar (see inference-sidecar/).
//     Holds the Google credential, mints the Vertex access token, and egresses
//     to Vertex THROUGH the proxy. Joined to every conversation network so each
//     agent can reach it by name -- the agent's only peer.
//   - the control plane joins each conversation network to DIAL its agent, but
//     binds its HTTP/ws listener to the frontend interface only (see
//     frontendIp + server.ts), so agents cannot reach the control-plane API.
//
// Each conversation is one agent container: NO bind-mount, a disposable named
// volume at /work, no host-published port (reached by name on its own network),
// and NO internet -- it talks only to the inference sidecar on its --internal
// network. The real model credential never enters the agent.
import { $ } from "bun";
import { currentGeneration, loadSettings } from "./settings-store";
import type { Settings } from "./settings";

const IMAGE = process.env.AGENT_IMAGE ?? "hakanai-agent:dev";
const LABEL = "hakanai";
const AGENT_PORT = 7000;
const EGRESS = "hakanai-egress";
const PROXY = "hakanai-proxy";
const INFERENCE = "hakanai-inference";
const INFERENCE_PORT = 8900;
const INFERENCE_IMAGE = process.env.INFERENCE_IMAGE ?? "hakanai-inference:dev";
// The state volume (ADC credential + activity index). Mounted by compose into
// the control plane and, via this name, into the sidecar so it reads the same
// credential. compose pins this exact name (compose.yaml) so both agree.
const STATE_VOLUME = process.env.HAKANAI_STATE_VOLUME ?? "hakanai-state";

// Per-conversation network name. Distinct from the agent container/volume name
// (hakanai-<id>) so the objects don't collide.
const convNet = (id: string) => `hakanai-net-${id}`;
// Extra comma-separated hosts the sidecar may reach, on top of the Vertex +
// token endpoints derived below. Usually empty.
const EGRESS_ALLOW = process.env.EGRESS_ALLOW ?? "";

// Google Cloud config (non-secret): which project/region/model. The agent gets
// these so pi's built-in google-vertex provider builds the right request path;
// the sidecar gets the location so it knows which regional Vertex host to
// forward to. The actual credential is NOT here -- it lives in the sidecar.
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "";
const GCP_LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

// The egress-proxy allowlist, recomputed from the CURRENT provider config (not
// boot env) every time infra is reconciled -- the single auditable chokepoint.
//   - vertex: the regional Vertex endpoint + Google's OAuth token endpoint (the
//     sidecar reaches these; the agent has no internet).
//   - openai: only the user's endpoint host (the agent reaches it directly
//     through the proxy; the sidecar is unused).
// Unconfigured: keep the Google hosts so the sidecar can still boot cleanly.
function egressAllow(s: Settings | null): string {
  if (s?.provider === "openai") {
    let host = "";
    try {
      host = new URL(s.endpoint).host; // carries the port iff non-default
    } catch {}
    return [host, EGRESS_ALLOW].filter(Boolean).join(",");
  }
  const location = s?.provider === "vertex" ? s.location : GCP_LOCATION;
  return [`${location}-aiplatform.googleapis.com`, "aiplatform.googleapis.com", "oauth2.googleapis.com", EGRESS_ALLOW]
    .filter(Boolean)
    .join(",");
}

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

// Idempotent: create the egress network, (re)run the egress proxy, and (re)run
// the inference sidecar. Per-conversation networks are created on demand in
// spawnAgent. Safe to call on every boot (the control plane boots at `up`,
// before any agents exist).
export async function ensureInfra(): Promise<void> {
  const s = await loadSettings();
  await $`docker network create ${EGRESS}`.nothrow().quiet();

  // Always (re)create the proxy so its allowlist tracks the current provider
  // config (Vertex Google hosts, or the OpenAI endpoint host).
  await $`docker rm -f ${PROXY}`.nothrow().quiet();
  await $`docker run -d --name ${PROXY} --network ${EGRESS} \
    -e ALLOW=${egressAllow(s)} -e PORT=8888 hakanai-egress:dev`.quiet();

  // Always (re)create the inference sidecar so its config tracks the current
  // Vertex project/location. It is unused in OpenAI mode (no agent is routed to
  // it) but harmless to keep running. It sits on the egress net (to reach the
  // proxy), egresses to Vertex through the proxy (HTTPS_PROXY), and reads the
  // ADC credential from the shared state volume. spawnAgent joins it to each
  // Vertex conversation network.
  const project = s?.provider === "vertex" ? s.project : GCP_PROJECT;
  const location = s?.provider === "vertex" ? s.location : GCP_LOCATION;
  await $`docker rm -f ${INFERENCE}`.nothrow().quiet();
  await $`docker run -d --name ${INFERENCE} --network ${EGRESS} \
    -e PORT=${INFERENCE_PORT} \
    -e GOOGLE_CLOUD_PROJECT=${project} \
    -e GOOGLE_CLOUD_LOCATION=${location} \
    -e GOOGLE_APPLICATION_CREDENTIALS=/state/adc.json \
    -e HTTP_PROXY=http://${PROXY}:8888 -e HTTPS_PROXY=http://${PROXY}:8888 \
    -v ${STATE_VOLUME}:/state \
    ${INFERENCE_IMAGE}`.quiet();
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

// The provider-specific peer an agent's conversation network must carry: the
// egress proxy (OpenAI, reached directly) or the inference sidecar (Vertex).
const peerFor = (s: Settings): string => (s.provider === "openai" ? PROXY : INFERENCE);

// Create/run one agent container for `id` under the current settings `s`,
// reusing the named /work volume (hakanai-<id>) iff it already exists -- so this
// serves BOTH a fresh spawn and a re-spawn that preserves history. Attaches the
// right provider peer + the control plane to the conversation net and waits for
// the agent to listen. The container is labeled with the config generation so a
// later reopen can tell whether it is stale.
async function runAgent(id: string, s: Settings, gen: number): Promise<void> {
  const n = name(id);
  const net = convNet(id);

  // This conversation's own isolated --internal network (no internet on its own;
  // no other agent is ever on it). Idempotent: it already exists on a re-spawn.
  await $`docker network create --internal ${net}`.nothrow().quiet();

  if (s.provider === "openai") {
    // OpenAI mode: the agent reaches the user's endpoint DIRECTLY through the
    // egress proxy (HTTP(S)_PROXY), so join the proxy to this net. The narrow,
    // egress-contained token is injected via env (entrypoint writes an
    // openai-completions models.json that reads it). No sidecar -- detach it in
    // case this is a switch from a prior Vertex spawn on the same net.
    await $`docker network disconnect -f ${net} ${INFERENCE}`.nothrow().quiet();
    await $`docker network connect ${net} ${PROXY}`.nothrow().quiet();
    await $`docker run -d --name ${n} \
      --label ${LABEL}=1 --label conv=${id} --label ${LABEL}.cfggen=${gen} \
      --network ${net} \
      --memory ${AGENT_MEMORY} --pids-limit ${AGENT_PIDS} --cpus ${AGENT_CPUS} \
      -e HAKANAI_PROVIDER=openai \
      -e HAKANAI_OPENAI_BASE_URL=${s.endpoint} \
      -e HAKANAI_OPENAI_API_KEY=${s.token} \
      -e HAKANAI_MODEL=${s.model} \
      -e HTTP_PROXY=http://${PROXY}:8888 -e HTTPS_PROXY=http://${PROXY}:8888 \
      -e http_proxy=http://${PROXY}:8888 -e https_proxy=http://${PROXY}:8888 \
      -v ${n}:/work \
      ${IMAGE}`.quiet();
  } else {
    // Vertex mode: the inference sidecar joins the net (the agent's only peer);
    // the agent has NO internet (no proxy joined). Non-secret Google config so
    // pi builds the right request path; the api key is a literal PLACEHOLDER
    // (the real credential lives in the sidecar).
    await $`docker network disconnect -f ${net} ${PROXY}`.nothrow().quiet();
    await $`docker network connect ${net} ${INFERENCE}`.nothrow().quiet();
    await $`docker run -d --name ${n} \
      --label ${LABEL}=1 --label conv=${id} --label ${LABEL}.cfggen=${gen} \
      --network ${net} \
      --memory ${AGENT_MEMORY} --pids-limit ${AGENT_PIDS} --cpus ${AGENT_CPUS} \
      -e HAKANAI_PROVIDER=vertex \
      -e GOOGLE_CLOUD_PROJECT=${s.project} \
      -e GOOGLE_CLOUD_LOCATION=${s.location} \
      -e GOOGLE_CLOUD_API_KEY=placeholder \
      -e HAKANAI_MODEL=${s.model} \
      -v ${n}:/work \
      ${IMAGE}`.quiet();
  }

  // Join the control plane so it can reach the agent by name, then wait.
  await $`docker network connect ${net} ${await selfName()}`.nothrow().quiet();
  await waitReady(n, AGENT_PORT);
}

export async function spawnAgent(): Promise<Conv> {
  const s = await loadSettings();
  if (!s) throw new Error("not_configured");
  const id = crypto.randomUUID().slice(0, 8);
  await runAgent(id, s, await currentGeneration());
  return { id, agentUrl: `ws://${name(id)}:${AGENT_PORT}`, createdAt: await createdAt(name(id)) };
}

// The config generation a conversation's container was spawned under, or null if
// there is no such container (or it carries no label, e.g. a pre-upgrade one).
async function agentGeneration(id: string): Promise<number | null> {
  try {
    const out = (await $`docker inspect -f {{index .Config.Labels "hakanai.cfggen"}} ${name(id)}`.text()).trim();
    if (!out || out === "<no value>") return null;
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Stop every running agent (used on a provider switch: the new config is applied
// at the next spawn, so in-flight agents under the old config must be stopped).
// History on /work survives -- reopening re-spawns under the current config
// (see startAgent's stale-generation branch).
export async function stopAllAgents(): Promise<void> {
  for (const id of await listRunning()) await stopAgent(id);
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

// Load a previously stopped conversation. Two cases:
//   - same config generation: the container's baked env + topology still match
//     the current provider, so just (idempotently) re-attach its peer -- which a
//     control-plane restart's ensureInfra() detaches when it recreates the
//     proxy/sidecar -- and `docker start` it (fast; in-memory session resumes).
//   - stale generation: the provider config changed since this container was
//     spawned, so its env/topology are wrong. Re-spawn under the CURRENT config,
//     reusing the /work volume so history survives (pi reloads it via
//     session/load). This is the handoff's "reopening re-spawns under the
//     current config."
export async function startAgent(id: string): Promise<void> {
  const s = await loadSettings();
  if (!s) throw new Error("not_configured");
  const cur = await currentGeneration();
  if ((await agentGeneration(id)) === cur) {
    await $`docker network connect ${convNet(id)} ${peerFor(s)}`.nothrow().quiet();
    await $`docker network connect ${convNet(id)} ${await selfName()}`.nothrow().quiet();
    await $`docker start ${name(id)}`.quiet();
    await waitReady(name(id), AGENT_PORT);
    return;
  }
  // Stale: discard the old container (keep the volume) and re-spawn fresh.
  await $`docker rm -f ${name(id)}`.nothrow().quiet();
  await runAgent(id, s, cur);
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

// Read a file back out of the conversation's /work volume so the browser can
// download it. The /work prefix check alone is NOT enough: the agent is hostile
// (prompt-injectable) and symlink-following would let it plant
// /work/x -> /root/.pi/agent/auth.json and exfiltrate the baked image's secrets,
// breaking the documented "/work only" guarantee. (This is also why we do not
// use `docker cp`, which follows symlinks.)
//
// So we resolve the real target, verify it stays under /work, verify it is a
// regular file (not a dir/device/socket), and stream its bytes -- all in ONE
// `docker exec sh -c`, so the resolve and the read see the same target with no
// window for the agent to swap the path, and there is no second, symlink-
// following copy step. Fail closed: a non-zero exit (missing file, escape,
// non-regular file, unresolvable symlink) returns null. The path arrives as $1
// so a hostile value cannot inject shell. (busybox realpath has no -e/-- flags,
// but it already fails on missing paths and the /work/ prefix check upstream
// guarantees the path never begins with a dash.)
export async function exportFile(id: string, path: string): Promise<{ bytes: Uint8Array; name: string } | null> {
  if (!path.startsWith("/work/") || path.includes("..")) throw new Error("path not allowed");
  const n = name(id);
  const guard = 'p=$(realpath "$1") || exit 1; case "$p" in /work/*) ;; *) exit 1 ;; esac; [ -f "$p" ] || exit 1; exec cat "$p"';
  const res = await $`docker exec ${n} sh -c ${guard} sh ${path}`.nothrow().quiet();
  if (res.exitCode !== 0) return null;
  return { bytes: res.bytes(), name: path.split("/").pop() || "file" };
}

export async function reapConversation(id: string): Promise<void> {
  const n = name(id);
  const net = convNet(id);
  await $`docker rm -f ${n}`.nothrow().quiet();
  await $`docker volume rm ${n}`.nothrow().quiet();
  // Detach the long-lived members so the network can be removed. Which one was
  // joined depends on the provider the conversation was spawned under (sidecar
  // for Vertex, proxy for OpenAI), so detach both -- a no-op for the absent one.
  await $`docker network disconnect -f ${net} ${INFERENCE}`.nothrow().quiet();
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
