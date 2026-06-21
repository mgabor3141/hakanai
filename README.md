# hako-ephemeral

A private, **provably-deletable** AI chat appliance for non-technical colleagues.
A fork-in-spirit of [hako](../hako): same capable agent, opposite invariants.

> Status: **prototype / tracer bullet.** The control-plane orchestration, the
> container boundary, and the browser-to-container transport are wired and
> runnable. The agent inside is a stub echo; egress lockdown, real `pi-acp` +
> AG-UI, and Vertex are marked seams (see "Deferred seams").

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

- `control-plane/` -- Bun server: serves the UI, REST for conversations, the
  ws proxy (browser <-> container), and the idle reaper. Talks to Docker by
  shelling out (no SDK dep yet).
- `agent-image/` -- the baked, immutable ephemeral image. Today a stub ws echo
  agent that writes a transcript into `/work` (the disposable volume) to prove
  data containment. Seam to `pi-acp`.

## Run the tracer

```sh
docker build -t hako-ephemeral-agent:dev agent-image
cd control-plane && bun server.ts        # http://127.0.0.1:8800
# in another shell:
bun control-plane/smoke.ts               # end-to-end: create -> chat -> verify -> reap
```

## Deferred seams (next slices, deliberately not in the tracer)

1. **Egress lockdown** -- run the container on a `--internal` docker network
   with a narrow allowlist proxy for the Vertex endpoint only. The single most
   important security control; trivial in v1 (one hole: Vertex).
2. **Real agent** -- swap the stub for `pi-acp` wrapped by `@rebornix/stdio-to-ws`;
   browser renders via AG-UI (`acp-to-agui` + CopilotKit) for a normie chat.
3. **Vertex** -- model creds in the control plane, injected per session.
4. **Pinning** -- pin the base image by digest, bump via Renovate PR (ADR-0008).
5. **Index durability** -- rebuild the conversation list from docker labels on
   boot; the in-memory activity map is prototype-only.
