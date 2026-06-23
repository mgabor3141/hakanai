// The appliance's runtime model configuration: a single GLOBAL provider config
// (not per-conversation), persisted to the state volume and applied at agent
// spawn time. Two provider modes, with a deliberate credential-placement
// asymmetry (see SECURITY.md / the settings-ui handoff):
//
//   - openai: an OpenAI-compatible endpoint + a narrow, scoped bearer token +
//     a model. The token is acceptable INSIDE the agent container -- it is
//     contained by the egress allowlist to that one endpoint host. The agent
//     reaches the endpoint directly through the egress proxy; the inference
//     sidecar is NOT used.
//   - vertex: a GCP project + location + model. The broad cloud-platform ADC
//     credential stays OUT of the agent, in the inference sidecar. The agent
//     holds only a placeholder and has zero internet.
//
// This module is the pure on-disk format + redaction policy + the curated
// Vertex model catalog. The filesystem glue (load/save, 0600) lives in
// settings-store.ts; the discovery/SSRF guard lives in ssrf.ts. Kept pure so
// it can be unit-tested without docker or a filesystem.

export type OpenAISettings = { provider: "openai"; endpoint: string; token: string; model: string };
export type VertexSettings = { provider: "vertex"; project: string; location: string; model: string };
export type Settings = OpenAISettings | VertexSettings;

// What GET /api/settings returns: provider + non-secret fields + presence flags.
// NEVER carries the token or ADC bytes (see the write-only-secrets decision).
export type PublicSettings =
  | { provider: "none" }
  | { provider: "openai"; endpoint: string; model: string; hasToken: boolean }
  | { provider: "vertex"; project: string; location: string; model: string; connected: boolean };

// The body POST /api/settings accepts. For openai, an absent/empty token means
// "keep the existing one" (preserve-on-blank); a non-empty token replaces it.
export type IncomingSettings =
  | { provider: "openai"; endpoint: string; token?: string; model: string }
  | { provider: "vertex"; project: string; location: string; model: string };

// Curated Gemini catalog for the Vertex dropdown. Vertex has no /v1/models
// discovery, so we ship a hardcoded list (the handoff's settled choice).
export const VERTEX_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
] as const;

// The OpenAI-compatible model-discovery URL for a user-entered base URL (also a
// connection test). Accepts both `https://host` (-> /v1/models) and a base that
// already carries a version segment like `https://host/v1` (-> /models). Pure ->
// unit-tested; the SSRF guard + the fetch live in the server.
export function modelDiscoveryUrl(endpoint: string): string {
  let e = endpoint.replace(/\/+$/, "");
  if (!/\/v\d+$/.test(e)) e += "/v1";
  return `${e}/models`;
}

// Serialize the full settings (WITH secrets) for the 0600 state file.
export function serializeSettings(s: Settings): string {
  return JSON.stringify(s, null, 2);
}

// Parse the on-disk form tolerantly: an unconfigured appliance (missing/corrupt
// file) yields null, and a half-written object that does not satisfy a provider
// shape yields null rather than throwing -- the control plane must still boot.
export function parseSettings(text: string): Settings | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.provider === "openai") {
    if (typeof o.endpoint === "string" && typeof o.token === "string" && typeof o.model === "string" && o.endpoint && o.model) {
      return { provider: "openai", endpoint: o.endpoint, token: o.token, model: o.model };
    }
    return null;
  }
  if (o.provider === "vertex") {
    if (typeof o.project === "string" && typeof o.location === "string" && typeof o.model === "string" && o.project && o.location && o.model) {
      return { provider: "vertex", project: o.project, location: o.location, model: o.model };
    }
    return null;
  }
  return null;
}

// The write-only redaction: strip the token / ADC, surface presence flags.
// `connected` (Vertex ADC present) is determined outside this module (the
// adc.json file's existence), so it is passed in.
export function redact(s: Settings | null, connected: boolean): PublicSettings {
  if (!s) return { provider: "none" };
  if (s.provider === "openai") {
    return { provider: "openai", endpoint: s.endpoint, model: s.model, hasToken: s.token.length > 0 };
  }
  return { provider: "vertex", project: s.project, location: s.location, model: s.model, connected };
}

// Merge an incoming POST onto the existing settings, applying preserve-on-blank
// for the openai token. Throws on a malformed body (the caller answers 400).
// Pure: no I/O, so the secret-preservation rule is unit-tested directly.
export function mergeIncoming(existing: Settings | null, incoming: IncomingSettings): Settings {
  if (incoming.provider === "openai") {
    const endpoint = (incoming.endpoint ?? "").trim();
    const model = (incoming.model ?? "").trim();
    if (!endpoint) throw new Error("endpoint required");
    // The egress proxy tunnels TLS only (CONNECT), so the agent can only reach an
    // https endpoint. Reject http up front rather than let the agent silently
    // fail to egress at prompt time. (Discovery, done by the control plane
    // directly, would still work over http -- but the agent never could.)
    if (!/^https:\/\//i.test(endpoint)) throw new Error("endpoint must use https (the egress proxy tunnels TLS only)");
    if (!model) throw new Error("model required");
    const incomingToken = (incoming.token ?? "").trim();
    // Preserve-on-blank: empty token field keeps the stored token, but only if
    // the existing config was ALSO openai (a provider switch has no token to keep).
    const prevToken = existing?.provider === "openai" ? existing.token : "";
    const token = incomingToken || prevToken;
    if (!token) throw new Error("token required");
    return { provider: "openai", endpoint, token, model };
  }
  if (incoming.provider === "vertex") {
    const project = (incoming.project ?? "").trim();
    const location = (incoming.location ?? "").trim();
    const model = (incoming.model ?? "").trim();
    if (!project) throw new Error("project required");
    if (!location) throw new Error("location required");
    if (!model) throw new Error("model required");
    return { provider: "vertex", project, location, model };
  }
  throw new Error("unknown provider");
}
