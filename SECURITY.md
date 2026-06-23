# Security model

hakanai's guarantees are the product, so this document states them plainly:
what it protects, how, what is out of scope, and how to check the claims. It
describes the current state; the *why* behind specific enforcement choices lives
in the [ADRs](docs/adr/).

## Threat model

- **One user, on their own machine.** Each colleague runs their own instance.
  PII never centralizes, so "delete it from this computer" is the whole scope.
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
question. An idle reaper enforces deletion after a TTL (default 3 days).

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
the internet directly) and `scripts/isolation-smoke.sh` (no agent reaches the
control-plane API or another agent).

## Known gaps

Honest about what is not yet guaranteed:

- **The idle-deletion clock is not durable.** It lives in control-plane memory,
  so a control-plane restart resets the TTL. The "deleted after N days idle"
  promise is therefore not yet restart-proof.
- **No per-agent resource or disk limits.** A runaway or hostile agent can
  exhaust host CPU, memory, or disk; the `/work` volume is unbounded.
- **Images and packages are not pinned by digest**, so builds are not yet
  reproducible or supply-chain-auditable.
- **The bind-to-frontend approach is validated on native Linux**, not yet on
  Docker Desktop (see ADR-0001).

## Reporting a vulnerability

This is a personal project and a prototype. If you find a security issue, please
open a GitHub issue describing it, or contact the maintainer directly for
anything you would rather not disclose publicly. There is no formal SLA.
