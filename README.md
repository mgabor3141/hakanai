# hako-ephemeral

A private, **provably-deletable** AI chat appliance for non-technical colleagues.
A fork-in-spirit of [hako](../hako): same capable agent, opposite invariants.

> Status: **prototype.** Wired and runnable end-to-end: control-plane
> orchestration, the container boundary, browser<->container transport, and
> **egress lockdown** (agents sit on a no-internet network; a CONNECT-allowlist
> proxy is their only way out). The agent inside is still a stub echo; real
> `pi-acp` + AG-UI and Vertex are the remaining seams.

## Why a separate thing from hako

hako is a *dev* harness: it bind-mounts a live home you edit in place, gates
writes with per-call approval, and ships as `git clone` + `git pull`. Ephemeral
mode **inverts every one of those** for a compliance reason, so it gets its own
codebase where the strong invariants are hard-coded, not toggled:

| hako (dev) | hako-ephemeral (sensitive) |
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
- **Model egress** goes to Google Vertex AI under a zero-data-retention
  agreement, so the provider side is contractually handled.
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
- `agent-image/` -- the baked, immutable ephemeral image. Today a stub ws echo
  agent that writes a transcript into `/work` (the disposable volume) to prove
  data containment. Seam to `pi-acp`.
- `egress-proxy/` -- the CONNECT-allowlist chokepoint image (agents' only route
  out). Allowlist passed via `ALLOW` (v1: the Vertex host).
- `scripts/egress-smoke.sh` -- proves the containment property in isolation.

## Run it

```sh
docker build -t hako-ephemeral-agent:dev agent-image
docker build -t hako-ephemeral-egress:dev egress-proxy
docker compose up -d --build      # control plane at http://127.0.0.1:8800
bun control-plane/smoke.ts        # e2e: create -> chat -> verify in volume -> reap
bash scripts/egress-smoke.sh      # proves egress containment (allow / deny / raw)
```

## Done so far

- Per-conversation ephemeral container: no bind-mount, disposable volume, reaped
  whole (the provable-deletion boundary).
- Browser <-> container websocket bridged through the control plane.
- **Egress lockdown**: agents on an `--internal` (no-internet) network; a
  CONNECT-allowlist proxy is the sole route out. Raw egress and off-list hosts
  both fail (`scripts/egress-smoke.sh`).
- Control plane containerized, joins the internal net, reaches agents by name.

## Remaining seams

1. **Real agent** -- swap the stub for `pi-acp` wrapped by `@rebornix/stdio-to-ws`;
   browser renders via AG-UI (`acp-to-agui` + CopilotKit) for a normie chat.
2. **Vertex** -- model creds in the control plane, injected per session; the
   egress allowlist set to the Vertex host.
3. **Pinning** -- pin base images by digest, bump via Renovate PR (ADR-0008).
4. **Index durability** -- the conversation list already rebuilds from docker
   labels; the in-memory activity map (for the reaper) is still prototype-only.
5. **Stop-on-idle / resume** -- today agents run until reaped; a cheaper model
   stops them on idle and restarts on resume (needs reattach handling).
6. **Harden the control-plane API** -- it currently binds all interfaces and the
   control plane is on the agent net, so an agent could reach the API; bind it
   off the internal net (agents never need to reach the control plane).
