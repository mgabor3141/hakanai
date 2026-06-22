# hakanai

A private, **provably-deletable** AI chat appliance for non-technical colleagues.
A fork-in-spirit of [hako](../hako): same capable agent, opposite invariants.

> Status: **prototype.** Wired and runnable end-to-end: control-plane
> orchestration, the container boundary, browser<->container transport,
> **egress lockdown** (agents on a no-internet network; a CONNECT-allowlist proxy
> their only way out), and a **real pi-acp agent** whose ACP handshake completes
> over the ws proxy, and a **working chat round-trip** to a configurable
> OpenAI-compatible model endpoint. Remaining polish: AG-UI rendering.

## Why a separate thing from hako

hako is a *dev* harness: it bind-mounts a live home you edit in place, gates
writes with per-call approval, and ships as `git clone` + `git pull`. Ephemeral
mode **inverts every one of those** for a compliance reason, so it gets its own
codebase where the strong invariants are hard-coded, not toggled:

| hako (dev) | hakanai (sensitive) |
|---|---|
| bind-mount the live home | **no** bind-mount; baked immutable image |
| per-call approval is the boundary | **read-only surface**; nothing to approve |
| update via `git pull`, opinions = conflicts | immutable image, **bump-by-PR to pins**, rebuild |
| persist everything in the clone | **disposable** volume, reaped after 3 days idle |

## The deal it makes

- **Provable local deletion.** A bash-capable agent can write anywhere, so the
  only *provable* deletion boundary is the container + its volume. Destroy them
  and the bytes are gone -- no "did it escape a subtree?" question.
- **No exfiltration path.** The agent is read-only outward and the container has
  **no general network egress** (only the model endpoint, plus the gateway once
  integrations land). bash + curl has nowhere to send data, so "we deleted
  everything" is true, not "everything we know about." This also matters because
  the agent reads untrusted input (uploaded reports, customer records) that can
  carry prompt-injection.
- **Single-user, on the colleague's own machine.** Each person runs their own
  instance; the agent acts with their own scoped credentials; PII never
  centralizes. "Delete from the user's computer" is the only scope there is.
- **Model egress** goes to one configurable OpenAI-compatible endpoint and
  nowhere else; for the PII guarantee that endpoint should be one you trust
  (self-hosted, or a vendor under a zero-data-retention agreement).
- **Out of scope by design:** what the human *deliberately* extracts (reads the
  verdict, copies it out). We delete the agent's data, not your screenshot.

## Architecture

```
  browser (localhost, no install)
        | wss + HTTP
        v
  CONTROL PLANE  (persistent)            holds: conversation index, model/gateway
  - serves the chat web UI               creds. No conversation PII lives here.
  - orchestrator (docker socket): run/reap
  - reaper: idle > 3d -> destroy container + volume
        | spawns (no bind-mount, disposable volume, egress-locked) + ws-proxies
        v
  DATA PLANE  (ephemeral, one per conversation)
  - pi-acp wrapped to websocket
  - disposable volume = the ONLY place PII lives
  - destroyed wholesale on reap
```

**Key finding that unblocks the UI:** ACP defines a **websocket transport** for
*remote* agents (working dir interpreted on the agent's host = the container).
So a browser chat UI can talk to `pi` *inside* the container over `wss://` via a
stdio->ws wrap. Transport is reuse, not build. What nobody else does is
**orchestrate a fresh isolated container per conversation** -- that is the
product, and it is what this repo builds.

## Layout

- `compose.yaml` -- runs the persistent control plane (docker socket + the
  published UI port). Agents are not here; they are created per conversation.
- `control-plane/` -- Bun server (containerized): serves the UI, REST for
  conversations, the ws proxy (browser <-> container), the idle reaper, and the
  docker orchestration (`ensureInfra` builds the networks + egress proxy and
  joins the control plane to the internal net). Shells out to `docker`.
- `agent/` -- the agent image: pi + pi-acp + `stdio-to-ws`, baked and immutable
  (`hakanai-agent:dev`). pi writes only to `/work` (the disposable volume). The
  env-driven model provider is `agent/extensions/hakanai-inference.ts`.
- `egress-proxy/` -- the CONNECT-allowlist chokepoint image (agents' only route
  out). Allowlist passed via `ALLOW` (the Vertex host).
- `hakanai` -- the one-command runner (builds images, brings the stack up).
- `scripts/egress-smoke.sh`, `scripts/acp-smoke.ts` -- creds-free checks (egress
  containment; ACP handshake through the full topology).

## Run it

One command from the repo root:

```sh
./hakanai          # builds the images + brings the stack up at http://127.0.0.1:8800
./hakanai down     # tear it all down
./hakanai smoke    # creds-free checks (egress containment + ACP handshake)
```

`./hakanai up` opens the UI -- Chrome/Chromium in **app mode** (a chromeless
window) if available, else your default browser (skip with `HAKANAI_NO_BROWSER=1`).
`./hakanai help` lists everything.

### Model auth

The model is any **OpenAI-compatible** endpoint, configured by env (put these in
a gitignored `.env` next to `compose.yaml`):

```sh
HAKANAI_MODEL_BASE_URL=https://inference.example/v1
HAKANAI_MODEL_API_KEY=...        # bearer token
HAKANAI_MODEL=default            # a model id the endpoint serves
```

The control plane injects these into each agent; a small pi extension
(`agent/extensions/hakanai-inference.ts`) registers the provider and discovers
models from `/v1/models`. The endpoint's host is added to the egress allowlist
automatically -- it is the only place an agent may reach. No creds are baked into
any image.

## Done so far

- Per-conversation ephemeral container: no bind-mount, disposable volume, reaped
  whole (the provable-deletion boundary).
- Browser <-> container websocket bridged through the control plane.
- **Egress lockdown**: agents on an `--internal` (no-internet) network; a
  CONNECT-allowlist proxy is the sole route out. Raw egress and off-list hosts
  both fail (`scripts/egress-smoke.sh`).
- Control plane containerized, joins the internal net, reaches agents by name.
- **Real pi-acp agent** (`agent/`) wrapped to ws by `stdio-to-ws`, on an
  internal-only, egress-locked container (`scripts/acp-smoke.ts`).
- **Working chat round-trip** to a configurable OpenAI-compatible endpoint: an
  env-driven pi extension registers the provider, and pi (run under bun so its
  fetch honors `HTTPS_PROXY`) reaches the model *only* through the egress proxy.
- **Browser is a real ACP client** (initialize -> session/new -> session/prompt
  -> streamed reply).

## Remaining seams

1. **AG-UI rendering** -- the browser speaks raw JSON today; render ACP via
   `acp-to-agui` + CopilotKit for a genuinely normie chat.
2. **Pinning** -- pin base images + npm versions by digest, bump via Renovate (ADR-0008).
3. **Index durability** -- the conversation list already rebuilds from docker
   labels; the in-memory activity map (for the reaper) is still prototype-only.
4. **Stop-on-idle / resume** -- today agents run until reaped; a cheaper model
   stops them on idle and restarts on resume (needs reattach handling).
5. **Harden the control-plane API** -- it currently binds all interfaces and the
   control plane is on the agent net, so an agent could reach the API; bind it
   off the internal net (agents never need to reach the control plane).
