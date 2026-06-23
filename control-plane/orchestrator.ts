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
const MODEL = process.env.HAKANAI_MODEL ?? "gemini-2.5-pro";

// The hosts the sidecar must reach: the regional Vertex endpoint (inference)
// and Google's OAuth token endpoint (access-token refresh). This is the whole
// egress allowlist now -- the single auditable chokepoint, retargeted from a
// generic model host to Google's surface.
function egressAllow(): string {
  return [`${GCP_LOCATION}-aiplatform.googleapis.com`, "aiplatform.googleapis.com", "oauth2.googleapis.com", EGRESS_ALLOW]
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
  await $`docker network create ${EGRESS}`.nothrow().quiet();

  // Always (re)create the proxy so its allowlist tracks current config.
  await $`docker rm -f ${PROXY}`.nothrow().quiet();
  await $`docker run -d --name ${PROXY} --network ${EGRESS} \
    -e ALLOW=${egressAllow()} -e PORT=8888 hakanai-egress:dev`.quiet();

  // Always (re)create the inference sidecar so its config tracks current env.
  // It sits on the egress net (to reach the proxy), egresses to Vertex through
  // the proxy (HTTPS_PROXY), and reads the ADC credential from the shared state
  // volume. spawnAgent joins it to each conversation network.
  await $`docker rm -f ${INFERENCE}`.nothrow().quiet();
  await $`docker run -d --name ${INFERENCE} --network ${EGRESS} \
    -e PORT=${INFERENCE_PORT} \
    -e GOOGLE_CLOUD_PROJECT=${GCP_PROJECT} \
    -e GOOGLE_CLOUD_LOCATION=${GCP_LOCATION} \
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

export async function spawnAgent(): Promise<Conv> {
  const id = crypto.randomUUID().slice(0, 8);
  const n = name(id);
  const net = convNet(id);

  // This conversation's own isolated network. The inference sidecar joins it (so
  // the agent can reach its only peer by name) and the control plane joins it
  // (so it can dial the agent by name); no other agent is ever on it. The agent
  // itself has NO internet -- the net is --internal and no proxy is on it.
  await $`docker network create --internal ${net}`.nothrow().quiet();
  await $`docker network connect ${net} ${INFERENCE}`.nothrow().quiet();

  // Non-secret Google config so pi's built-in google-vertex provider builds the
  // right request path; the api key is a literal PLACEHOLDER (the real
  // credential lives in the sidecar). models.json (baked) points the provider's
  // baseUrl at the sidecar. No HTTP(S)_PROXY: the agent must not reach the
  // internet, only the sidecar.
  await $`docker run -d --name ${n} \
    --label ${LABEL}=1 --label conv=${id} \
    --network ${net} \
    --memory ${AGENT_MEMORY} --pids-limit ${AGENT_PIDS} --cpus ${AGENT_CPUS} \
    -e GOOGLE_CLOUD_PROJECT=${GCP_PROJECT} \
    -e GOOGLE_CLOUD_LOCATION=${GCP_LOCATION} \
    -e GOOGLE_CLOUD_API_KEY=placeholder \
    -e HAKANAI_MODEL=${MODEL} \
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
  // Detach the long-lived members so the network can be removed.
  await $`docker network disconnect -f ${net} ${INFERENCE}`.nothrow().quiet();
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
