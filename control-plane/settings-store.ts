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
export async function saveSettings(s: Settings): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await Bun.write(tmp, serializeSettings(s));
  await chmod(tmp, 0o600);
  await rename(tmp, SETTINGS_FILE);
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
