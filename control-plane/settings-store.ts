// Filesystem glue for the global appliance settings: load/save the 0600 state
// file and report whether a Vertex ADC credential is present. The on-disk
// format + redaction policy is pure (settings.ts); this is the I/O around it.
//
// The settings file holds secrets (the openai token), so it lives in the same
// /state boundary as activity.json and is written mode 0600 -- read only to
// inject at spawn time. The Vertex ADC lives separately at /state/adc.json (the
// path the sidecar's GOOGLE_APPLICATION_CREDENTIALS already expects), written
// by the "Connect Google" flow; its mere existence is the `connected` flag.
import { chmod, mkdir, rename } from "node:fs/promises";
import { parseSettings, serializeSettings, type Settings } from "./settings";

const STATE_DIR = process.env.HAKANAI_STATE_DIR ?? "/state";
const SETTINGS_FILE = `${STATE_DIR}/settings.json`;
const GENERATION_FILE = `${STATE_DIR}/settings.gen`;
export const ADC_FILE = `${STATE_DIR}/adc.json`;

export async function loadSettings(): Promise<Settings | null> {
  try {
    const f = Bun.file(SETTINGS_FILE);
    if (!(await f.exists())) return null;
    return parseSettings(await f.text());
  } catch (e) {
    console.error("settings load failed (treating as unconfigured):", e);
    return null;
  }
}

// Atomic write at mode 0600 (same as activity.json's boundary). The temp file is
// chmod'd before the rename so the secret is never briefly world-readable.
// Bumps the config generation so already-spawned agents are recognized as stale
// (their baked env + network topology reflect the OLD provider) and get
// re-spawned under the new config when reopened, not cheaply `docker start`ed.
export async function saveSettings(s: Settings): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await Bun.write(tmp, serializeSettings(s));
  await chmod(tmp, 0o600);
  await rename(tmp, SETTINGS_FILE);
  await bumpGeneration();
}

// The monotonic config generation, persisted so it survives a control-plane
// restart (a restart must NOT make every conversation look stale). Returns 0
// before the first save. The orchestrator labels each spawned agent with the
// generation it was created under and compares on reopen.
export async function currentGeneration(): Promise<number> {
  try {
    const f = Bun.file(GENERATION_FILE);
    if (!(await f.exists())) return 0;
    const n = Number((await f.text()).trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function bumpGeneration(): Promise<void> {
  const next = (await currentGeneration()) + 1;
  const tmp = `${GENERATION_FILE}.tmp`;
  await Bun.write(tmp, String(next));
  await rename(tmp, GENERATION_FILE);
}

// Whether a Vertex ADC credential has been written (the "Connect Google" flow
// completed). This is the `connected` presence flag the redacted GET returns.
export async function adcConnected(): Promise<boolean> {
  try {
    return await Bun.file(ADC_FILE).exists();
  } catch {
    return false;
  }
}
