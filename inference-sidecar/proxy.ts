// The auth-injecting inference sidecar.
//
// Why this exists: pi talks to Google Vertex natively (its built-in
// `google-vertex` provider, built on @google/genai), but Vertex authenticates
// with a SHORT-LIVED OAuth access token minted from a Google credential -- and
// that credential is a full Google Cloud identity, not something we want sitting
// inside a prompt-injectable agent container. So the agent container holds only
// a PLACEHOLDER key, and its `google-vertex` baseUrl is pointed here (see
// agent/models.json). This sidecar holds the real credential, mints/refreshes
// the access token, and forwards each request to real Vertex with the token
// swapped in. The agent therefore needs ZERO internet: it only ever talks to
// this peer on its own --internal network.
//
// The forward is a near-verbatim pass-through: @google/genai (vertex mode)
// already sends Vertex-shaped requests
//   POST {baseUrl}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent
// so we keep the path + query as-is, only (a) retarget the host to the real
// regional Vertex endpoint and (b) replace whatever placeholder auth the SDK
// attached with a fresh `Authorization: Bearer <token>`.
//
// This sidecar itself has NO direct internet route: it egresses through the
// existing CONNECT-allowlist proxy (HTTPS_PROXY), so there is still exactly one
// auditable chokepoint, now allowlisting the Google endpoints. google-auth's
// gaxios honors HTTPS_PROXY for the token refresh; bun's fetch honors it for the
// forward.
import { GoogleAuth } from "google-auth-library";

const PORT = Number(process.env.PORT ?? 8900);
// The region whose Vertex endpoint we forward to. The agent uses the SAME value
// for GOOGLE_CLOUD_LOCATION, so the path the SDK builds and the host we target
// agree. Required; without it we cannot name an upstream.
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "";
// The project to scope requests to. Needed because the agent authenticates to us
// with a PLACEHOLDER api key, and @google/genai in api-key mode emits the
// project-less "express" path (publishers/google/models/...). Real Vertex with a
// Bearer token requires the projects/{p}/locations/{l}/ prefix, so we re-insert
// it here (see normalizePath).
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "";

// cloud-platform is the only OAuth scope Vertex accepts (there is no Vertex-only
// scope). Blast radius is bounded architecturally -- the credential lives here,
// never in the agent -- not by scope. GoogleAuth reads the credential from
// GOOGLE_APPLICATION_CREDENTIALS (an ADC file on the state volume) and caches +
// refreshes the access token internally.
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

// Re-insert the projects/{project}/locations/{location}/ scope that @google/genai
// omits in api-key mode. If the path already carries `/projects/` (ADC mode), or
// has no recognizable models segment, it is left untouched. Pure -> unit-tested.
export function normalizePath(pathname: string, project: string, location: string): string {
  if (pathname.includes("/projects/")) return pathname;
  const i = pathname.indexOf("publishers/google/models");
  if (i < 0) return pathname; // unknown shape (e.g. models.list); forward as-is
  return `${pathname.slice(0, i)}projects/${project}/locations/${location}/${pathname.slice(i)}`;
}

// Build the real upstream URL from the incoming request. Pure (no I/O) so it is
// unit-tested: host becomes the regional Vertex endpoint, the path is scoped to
// the project/location (normalizePath), and any `?key=` the SDK appended for
// placeholder-key auth is dropped (we authenticate with a Bearer token, and a
// stray bad key would 401 upstream).
export function upstreamUrl(location: string, project: string, pathname: string, search: string): string {
  const u = new URL(`https://${location}-aiplatform.googleapis.com`);
  u.pathname = normalizePath(pathname, project, location);
  u.search = search;
  u.searchParams.delete("key");
  return u.toString();
}

// Headers to forward upstream. Strip the incoming auth (placeholder, replaced
// with the real token), the hop-by-hop/host/length headers (fetch recomputes
// them for the new target), and the SDK's api-key header. Pure -> unit-tested.
const DROP = new Set(["host", "authorization", "x-goog-api-key", "content-length", "connection", "accept-encoding"]);
export function forwardHeaders(incoming: Headers): Headers {
  const h = new Headers();
  for (const [k, v] of incoming) if (!DROP.has(k.toLowerCase())) h.set(k, v);
  return h;
}

// Stamp the quota/billing project on the forwarded request. An in-container
// `gcloud auth application-default login` cannot infer a quota project, so the
// ADC carries none; Vertex then rejects requests with "unable to determine the
// project". The sidecar already knows the project (GOOGLE_CLOUD_PROJECT), so it
// sets x-goog-user-project here -- the per-request way to name the quota project
// without baking one into the credential. No-op when project is unset (so a
// future quota-project-bearing ADC is left to speak for itself). Pure ->
// unit-tested.
export function applyQuotaProject(headers: Headers, project: string): void {
  if (project) headers.set("x-goog-user-project", project);
}

async function handle(req: Request): Promise<Response> {
  if (!LOCATION) return new Response("sidecar misconfigured: GOOGLE_CLOUD_LOCATION unset\n", { status: 500 });

  let token: string | null | undefined;
  try {
    token = await auth.getAccessToken();
  } catch (e) {
    // No usable credential yet (e.g. the user has not connected an account), or
    // the refresh failed. 502 so pi surfaces a clear upstream error.
    return new Response(`sidecar auth failed: ${(e as Error).message}\n`, { status: 502 });
  }
  if (!token) return new Response("sidecar auth failed: no access token\n", { status: 502 });

  const inUrl = new URL(req.url);
  // One line per request (method + path only; never the body, which carries the
  // prompt). Useful for operating the chokepoint.
  console.log(`${req.method} ${inUrl.pathname}`);
  const headers = forwardHeaders(req.headers);
  headers.set("Authorization", `Bearer ${token}`);
  applyQuotaProject(headers, PROJECT);

  // Buffer the request body (a single JSON POST); only the RESPONSE streams (SSE
  // for streamGenerateContent), which we pass through untouched below.
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  const upstream = await fetch(upstreamUrl(LOCATION, PROJECT, inUrl.pathname, inUrl.search), {
    method: req.method,
    headers,
    body,
  });

  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("content-encoding"); // fetch already decoded; length/encoding would mislead
  respHeaders.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

if (import.meta.main) {
  Bun.serve({ port: PORT, idleTimeout: 240, fetch: handle });
  console.log(`hakanai inference sidecar :${PORT} -> ${LOCATION || "(no location!)"}-aiplatform.googleapis.com`);
}
