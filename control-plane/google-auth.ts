// The Vertex "Connect Google" flow: a control-plane-driven `gcloud auth
// application-default login` that uses the out-of-band paste-the-code flow (no
// browser, no loopback redirect, no published port -- works cross-platform).
//
// Validated behavior (see the settings-ui handoff): inside google/cloud-sdk
// with no browser, gcloud prints a consent URL, then WAITS on stdin for the
// verification code the user pastes back from their browser, exchanges it, and
// writes application_default_credentials.json under $CLOUDSDK_CONFIG. We point
// CLOUDSDK_CONFIG at /state/gcloud (on the shared state volume), so once the
// flow completes the control plane can read the file off its own /state mount
// and normalize it to /state/adc.json -- the path the sidecar already expects.
//
// Lifecycle: one flow at a time. start() spawns the helper with piped stdio and
// returns the consent URL; complete() writes the code to its stdin and waits;
// status() is polled by the UI; a ~5 minute timeout aborts and removes the
// helper container. This is a setup-time OPERATOR action, so the helper uses the
// default bridge (direct internet) -- it does NOT go through our egress proxy.
import { $ } from "bun";
import { copyFile, rename } from "node:fs/promises";
import { ADC_FILE } from "./settings-store";

// google/cloud-sdk:slim pinned by digest (renovate.json's docker policy; this
// image is only ever `docker run`, with no Dockerfile, so the digest is pinned
// here as a constant rather than in the pinning-smoke Dockerfile loop). Renovate
// still tracks it: the tag is in the comment. Single-arch (amd64); on Apple
// Silicon it emulates, acceptable for a one-off operator action.
export const GCLOUD_IMAGE =
  process.env.GCLOUD_IMAGE ??
  "google/cloud-sdk:slim@sha256:e379150995766ed2575edcfc6183e6fe212ed7def3465e7aad0b59d7de8392da";

const HELPER = "hakanai-gcloud-auth";
const STATE_VOLUME = process.env.HAKANAI_STATE_VOLUME ?? "hakanai-state";
const STATE_DIR = process.env.HAKANAI_STATE_DIR ?? "/state";
// Where gcloud writes the ADC inside the helper (CLOUDSDK_CONFIG); the same path
// on the control plane's /state mount, since both share the state volume.
const GCLOUD_CONFIG = "/state/gcloud";
const ADC_SRC = `${STATE_DIR}/gcloud/application_default_credentials.json`;
const TIMEOUT_MS = 5 * 60_000;

type Phase = "idle" | "pending" | "connected" | "error";
type Flow = {
  phase: Phase;
  url: string | null;
  error: string | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  timer: ReturnType<typeof setTimeout> | null;
};
const flow: Flow = { phase: "idle", url: null, error: null, proc: null, timer: null };

async function killHelper(): Promise<void> {
  if (flow.timer) clearTimeout(flow.timer);
  flow.timer = null;
  try {
    flow.proc?.kill();
  } catch {}
  flow.proc = null;
  await $`docker rm -f ${HELPER}`.nothrow().quiet();
}

// Spawn the helper and read stdout until the consent URL appears. Returns the
// URL. Replaces any previous flow (only one at a time). Throws on spawn failure.
export async function startGoogleAuth(): Promise<string> {
  await killHelper();
  flow.phase = "pending";
  flow.url = null;
  flow.error = null;

  // -i: keep stdin open so we can write the code later. --rm: the container is
  // removed on exit. CLOUDSDK_CONFIG on the shared volume so the ADC lands where
  // the control plane can read it.
  const proc = Bun.spawn(
    [
      "docker", "run", "-i", "--rm", "--name", HELPER,
      "-e", `CLOUDSDK_CONFIG=${GCLOUD_CONFIG}`,
      "-v", `${STATE_VOLUME}:/state`,
      GCLOUD_IMAGE,
      "gcloud", "auth", "application-default", "login", "--no-launch-browser",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  flow.proc = proc;
  flow.timer = setTimeout(() => {
    flow.phase = "error";
    flow.error = "timed out waiting for the verification code";
    void killHelper();
  }, TIMEOUT_MS);

  // gcloud prints the URL to stderr (the prompt text) on some versions and
  // stdout on others; scan both.
  const url = await readForUrl(proc);
  if (!url) {
    const phase = flow.phase;
    await killHelper();
    flow.phase = "error";
    flow.error = phase === "error" ? flow.error : "gcloud did not emit a consent URL";
    throw new Error(flow.error ?? "auth start failed");
  }
  flow.url = url;
  return url;
}

// Read both streams until the accounts.google.com consent URL appears (or the
// process exits / a timeout fires). Returns the URL, or null on failure.
//
// Each stream gets its OWN independent read loop appending into a shared buffer:
// gcloud prints the prompt text to one stream and may interleave; a single
// reader with Promise.any across both would issue overlapping read()s on the
// same reader and throw. A shared promise resolves as soon as either loop sees
// the URL.
async function readForUrl(proc: ReturnType<typeof Bun.spawn>): Promise<string | null> {
  const re = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?\S+/;
  let buf = "";
  let resolve!: (v: string | null) => void;
  const found = new Promise<string | null>((r) => (resolve = r));

  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const m = re.exec(buf);
        if (m) {
          resolve(m[0]);
          return;
        }
      }
    } catch {
      // stream errored/closed; the other loop or the timeout decides the result
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  };

  // Both pumps run; whichever finds the URL resolves `found`. If both streams end
  // without it (process exited early) or the timeout fires, resolve null.
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(() => resolve(null));
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), 90_000));
  void pumps;
  return Promise.race([found, timeout]);
}

// Write the pasted code to the helper's stdin, wait for it to exchange + write
// the ADC, then normalize the file to /state/adc.json. Returns the final phase.
export async function completeGoogleAuth(code: string): Promise<Phase> {
  if (flow.phase !== "pending" || !flow.proc) throw new Error("no auth flow in progress");
  const proc = flow.proc;
  try {
    proc.stdin?.write(new TextEncoder().encode(code.trim() + "\n"));
    await proc.stdin?.flush?.();
    proc.stdin?.end?.();
  } catch (e) {
    flow.phase = "error";
    flow.error = `failed to send code: ${(e as Error).message}`;
    await killHelper();
    return flow.phase;
  }
  const exit = await proc.exited;
  if (flow.timer) clearTimeout(flow.timer);
  flow.timer = null;
  if (exit !== 0) {
    flow.phase = "error";
    flow.error = `gcloud exited ${exit} (the code may be wrong or expired)`;
    await killHelper();
    return flow.phase;
  }
  // Normalize the freshly-written ADC to the path the sidecar expects.
  try {
    await rename(ADC_SRC, ADC_FILE).catch(async () => {
      await copyFile(ADC_SRC, ADC_FILE);
    });
  } catch (e) {
    flow.phase = "error";
    flow.error = `ADC written but could not be normalized: ${(e as Error).message}`;
    flow.proc = null;
    return flow.phase;
  }
  flow.phase = "connected";
  flow.proc = null;
  return flow.phase;
}

export function googleAuthStatus(): { phase: Phase; url: string | null; error: string | null } {
  return { phase: flow.phase, url: flow.url, error: flow.error };
}

export async function abortGoogleAuth(): Promise<void> {
  await killHelper();
  flow.phase = "idle";
  flow.url = null;
  flow.error = null;
}
