# Security model

hakanai's guarantees are the product, so this document states them plainly:
what it protects, how, what is out of scope, and how to check the claims. It
describes the current state; the *why* behind specific enforcement choices lives
in the [ADRs](docs/adr/).

## Threat model

- **One user, on their own machine.** Each colleague runs their own instance.
  PII never centralizes, so "delete it from this computer" is the whole scope.
- **The user's browser visits hostile pages.** The control plane has no accounts
  (there is one user), so any web page the user opens in the same browser is a
  threat: it can try to drive the localhost API across origins (CSRF) or rebind
  its own hostname to 127.0.0.1 to read transcripts (DNS rebinding). The bind to
  loopback stops the LAN and the agents, but not the user's own browser.
- **The agent runs untrusted input.** It reads uploaded documents, records, and
  the like, so it must be assumed **prompt-injectable**. The design does not
  rely on the agent behaving; it relies on the agent being unable to reach
  anything it should not.
- **The model endpoint is semi-trusted.** Agent reasoning and the content it is
  given do reach the configured model endpoint. For the PII guarantee that
  endpoint should be one you trust (self-hosted, or a vendor under zero data
  retention). It is the one place data deliberately leaves an agent.

## Guarantees and how they are enforced

### 1. Provable deletion

A bash-capable agent can write anywhere, so the only honest deletion boundary is
the **container plus its disposable volume**. Each conversation is exactly one
agent container and one named `/work` volume; deleting the conversation does
`docker rm -f` on the container and `docker volume rm` on the volume. There is
no bind mount and no shared store, so there is no "did it escape a subtree?"
question. An idle reaper enforces deletion after a TTL (default 3 days). The
last-activity clock is **persisted to a control-plane state volume**, recorded at
activity time, so a control-plane restart, redeploy, or outage cannot extend the
TTL (see [ADR-0003](docs/adr/0003-durable-deletion-clock.md)). That state holds
only `{conversationId: timestamp}`, never conversation content.

Proven by `scripts/clock-smoke.sh`.

### 2. No exfiltration path

Agents sit on a **no-internet (`--internal`) network**. Their only route out is a
**CONNECT-allowlist proxy** whose allowlist is just the model endpoint's host
(plus anything explicitly added via `EGRESS_ALLOW`). Raw egress and off-list
hosts both fail. No credentials are baked into any image; model auth is injected
per agent as env and can only travel to the allowlisted host. Even under prompt
injection, untrusted input has nowhere to phone home.

Proven by `scripts/egress-smoke.sh`.

### 3. Cross-conversation isolation

One conversation's data must never reach another. Two enforcements, both at the
network layer (see [ADR-0001](docs/adr/0001-cross-conversation-isolation.md)):

- **One `--internal` network per conversation.** No agent shares a network with
  another, so one agent cannot reach another agent's ACP socket or transcript.
- **The control-plane API binds to the frontend interface only.** The control
  plane dials agents but does not listen on the per-conversation networks, so an
  agent cannot reach the control-plane API (which would otherwise expose every
  conversation's files, deletion, and spawning).

Proven by `scripts/isolation-smoke.sh`.

### 4. Bounded resource use

Each agent runs with a generous memory cap, a process-count cap (`--pids-limit`,
the fork-bomb guard), and a CPU cap, so a runaway or hostile agent cannot fork-
bomb, peg every core, or eat all the RAM. At most `HAKANAI_MAX_ACTIVE` agents
run at once (default 2); idle ones are stopped to stay within budget. See
[ADR-0002](docs/adr/0002-memory-budget.md).

Proven by `scripts/limit-smoke.sh`.

### 5. Browser-origin protection (CSRF / DNS rebinding)

The control-plane API has no accounts by design, so the localhost bind is its
only network boundary — and that boundary does not cover the user's own browser
pointed at us by a hostile page. Every request is therefore checked at the door
before any routing (see [ADR-0004](docs/adr/0004-browser-origin-guard.md)):

- **Host must name this listener** (`127.0.0.1:8800` / `localhost:8800`). A
  DNS-rebinding page that re-points its own hostname at 127.0.0.1 still sends its
  own name in `Host`, so this rejects it — including on GET reads that return PII
  (`/files`) and on the websocket upgrade, which is where transcripts would leak.
- **Origin must match on state-changing requests and the ws upgrade.** Browsers
  attach `Origin` to cross-site writes and to every websocket handshake, so a
  hostile page cannot forge it; its spawn/delete/upload or ws connection is
  rejected. Plain cross-site GET reads need no Origin check — the same-origin
  policy already stops the attacker reading the response, and the rebinding case
  (where they could) is caught by the Host check.

There is deliberately **no bearer token**: for a single-user loopback service the
Host+Origin check already defeats both CSRF and rebinding, and a token would add
storage/injection surface and friction without closing a remaining gap (see
ADR-0004). The pure decision logic is pinned by unit tests in
`control-plane/origin-guard.test.ts`.

Proven by `scripts/origin-smoke.sh`.

### Control plane holds no conversation PII

The control plane keeps a conversation index and the model/egress config only.
Conversation content lives solely in each agent's disposable volume.

## Out of scope by design

- **What the human deliberately extracts.** Reading the answer and copying it out
  is the point; we delete the agent's data, not your screenshot.
- **What the model endpoint sees.** Content sent to the model is by definition
  shared with it; trust in the endpoint is a deployment choice (see threat
  model).
- **A malicious host or docker daemon.** The control plane drives the daemon;
  whoever controls the host controls everything. hakanai protects the user's
  data from the agent, not from themselves or their own machine's owner.

## Verifying the claims

The guarantees are checkable, not just asserted. With the stack up:

```sh
./hakanai smoke   # egress containment + ACP handshake + cross-conversation isolation
```

This runs `scripts/egress-smoke.sh` (no agent reaches a non-allowlisted host or
the internet directly), `scripts/origin-smoke.sh` (a forged or missing Origin
and a rebound Host are rejected while the real UI works),
`scripts/isolation-smoke.sh` (no agent reaches the control-plane API or another
agent), `scripts/limit-smoke.sh` (the resource budget holds), and
`scripts/clock-smoke.sh` (the deletion clock survives a control-plane restart).

## Known gaps

Honest about what is not yet guaranteed:

- **No `/work` disk-size cap.** Memory, process-count, and CPU are capped per
  agent, but the disposable volume is unbounded; docker's local volume driver
  cannot enforce a size cap portably (it needs a quota-backed filesystem).
- **The Alpine OS layer (apk packages) is not version-pinned.** Alpine repos
  serve only the current version of each package, so `pkg=version` pins break on
  the next repo roll; reproducibility for that layer comes from the base-image
  digest instead. Base images are pinned by `@sha256` digest and npm/pip
  packages by exact version, all bumped via Renovate.
- **The bind-to-frontend approach is validated on native Linux**, not yet on
  Docker Desktop (see ADR-0001).

## Reporting a vulnerability

This is a personal project and a prototype. If you find a security issue, please
open a GitHub issue describing it, or contact the maintainer directly for
anything you would rather not disclose publicly. There is no formal SLA.
