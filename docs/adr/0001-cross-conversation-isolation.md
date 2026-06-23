# ADR-0001: Cross-conversation isolation via per-conversation networks and a frontend-bound API

- **Status:** Accepted — 2026-06-23

## Context

hakanai's promise is that one conversation's data never leaks to another, even
though the agent runs untrusted input (uploaded documents, customer records) and
must be assumed prompt-injectable. The original topology put every agent and the
control plane on one shared `--internal` network, because the control plane
needs to reach agents by name to proxy the browser's websocket.

Docker network membership is bidirectional: being on a network to dial out also
means being reachable on it. That opened two cross-conversation holes, both
verified from inside a live agent with a raw socket (which ignores `HTTP_PROXY`,
the way a hostile agent would):

- **Agent to control-plane API.** A socket to `control-plane:8800` returned the
  full conversation list and could read any conversation's `/work` via the
  export endpoint, delete conversations, and spawn agents.
- **Agent to another agent.** Agent A could open agent B's ACP websocket
  (`hakanai-<B>:7000`) and `session/load` B's transcript.

The egress proxy does not help here: it is honored only voluntarily, and a raw
socket bypasses it.

The control plane only ever *dials* agents (the browser connects to the control
plane, which then opens a websocket to the agent). Agents never need to connect
in. So the fix is to manufacture one-way reachability.

## Decision

Two changes, enforced at the network layer rather than the application layer:

1. **One `--internal` network per conversation** (`hakanai-net-<id>`). No agent
   shares a network with another, so agent-to-agent reachability is gone. The
   single egress proxy joins each conversation network so agents keep model
   access; because it only forwards to allowlisted hosts and does not route
   between its interfaces, it is not a pivot between conversations.

2. **The control-plane API binds to the frontend interface only.** The published
   port (`127.0.0.1:8800`) is delivered by docker to the control plane's IP on
   the compose default bridge; the control plane discovers that IP via the
   docker socket and binds its HTTP/ws listener there. The per-conversation
   networks it joins to dial agents have no listener, so agents cannot reach the
   API at all.

`scripts/isolation-smoke.sh` proves both: from inside one agent, raw sockets to
the control-plane API and to another agent must all be refused. It runs in
`./hakanai smoke`.

### Alternatives considered

- **A shared bearer token (gmux-style), via a launch URL and cookie.** Closes
  the API hole and is docker- and OS-agnostic, but it is an application-layer
  secret to generate, persist, and never leak, and it does not address
  agent-to-agent. We keep it as a fallback if some environment fails to deliver
  the published port to the bridge IP.
- **Source-IP authorization** (reject API calls from agent subnets). Fragile
  through docker's NAT and the userland proxy.

We chose interface-binding over the token because the evidence was clean (the
docker DNAT rule sends the published port to the bridge IP, not the internal
IP), it removes an entire class of app-layer secret handling, and a bug in the
API then cannot be *reached* rather than relying on a check.

## Consequences

- Agents are isolated from the control-plane API and from each other at the
  network layer. This is the spine of the single-user PII-isolation promise.
- More docker objects per conversation (a network), created on spawn and removed
  on reap and by `down`. The proxy and control plane join each conversation
  network and detach on reap.
- The listener no longer binds `0.0.0.0`; it discovers the frontend IP at boot
  and falls back to all interfaces only off-container (dev), where there are no
  agents to wall off.
- **Caveat to validate:** the DNAT-to-bridge-IP behavior is created by the
  docker engine, which on Docker Desktop runs inside a Linux VM, so binding to
  the bridge IP should behave the same there. This is confirmed on native Linux;
  it should be smoke-tested on Docker Desktop before shipping, with the token as
  the fallback if a target environment does not DNAT to the bridge IP.
