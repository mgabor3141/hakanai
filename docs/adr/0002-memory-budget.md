# ADR-0002: A single-machine memory budget (bounded concurrency + per-agent caps)

- **Status:** Accepted — 2026-06-23

## Context

hakanai runs on a colleague's own machine, including lower-specced ones. Each
conversation is a separate container running pi plus a document and media
toolkit, and the per-agent footprint is the thing that multiplies: roughly
150-250MB idle and much more under load. Without a limit, a handful of open
conversations would exhaust a small machine, and a single runaway or hostile
agent (untrusted input is assumed prompt-injectable) could fork-bomb, peg every
core, or eat all the RAM.

The footprint is essentially:

```
footprint ≈ fixed (control plane + egress proxy) + N × per_agent_cap
```

So bounding it is two knobs: how many agents run at once (N), and how large each
agent may get.

## Decision

Treat it as one "memory budget" feature with two parts.

**Bounded concurrency.** At most `HAKANAI_MAX_ACTIVE` agent containers run at
once (default 2). When activating or creating a conversation would exceed the
cap, the control plane stops the least-recently-used **idle** conversation to
make room. Stopping is `docker stop`, not delete: the container and its `/work`
volume survive, the deletion clock keeps running, and reopening restarts the
container and reloads history from the volume over ACP. Pausing was rejected
because `docker pause` (SIGSTOP) frees CPU but not RAM.

A conversation is **busy** while it has an in-flight `session/prompt` (observed
on the proxied ws). The budget never silently interrupts busy work: if the only
way to free a slot is to stop a busy conversation, the control plane returns
`409 { wouldInterrupt }`, the UI asks the user in plain language ("...you will
not lose that conversation; only the task it is running now will be
interrupted"), and only on confirmation does the client retry with `force=1`.

**Per-agent caps.** Each agent runs with `--memory` (default `4g`),
`--pids-limit` (default `512`), and `--cpus` (default `2`).

- Memory is a **generous backstop**, not the working budget: heavy toolkit work
  (ffmpeg, libreoffice) must not trip it, and swap is left at the default so the
  host rarely OOM-kills. If it ever does, the control plane detects the kill
  (`State.OOMKilled` / exit 137) and tells the browser plainly instead of
  showing a bare disconnect.
- `--pids-limit` is the fork-bomb defense (a CPU cap does not prevent PID-table
  exhaustion; it only slows the rate while the process count still explodes).
- `--cpus` keeps one chat from pegging the machine, but is generous because the
  media toolkit is legitimately CPU-heavy.

Proven by `scripts/limit-smoke.sh` (at the cap, an extra conversation is stopped
not deleted, and each agent carries memory/pids/cpu limits).

### Alternatives considered

- **Runtime free-RAM gating** (refuse to spawn when free RAM is low). Rejected as
  the primary mechanism: "free RAM" is a slippery metric and the failure mode
  ("it sometimes won't open a chat and I don't know why") is exactly the
  nondeterminism a non-technical user cannot reason about. A fixed, visible cap
  ("2 of 2 chats running") is explainable.
- **Auto-deriving N and the caps from total RAM at boot.** Deferred, not
  rejected. The container sees the Docker VM's memory allocation, which is the
  correct signal even on Docker Desktop, so this is a good future default. For
  now a fixed env var is simpler; we will revisit derivation.
- **A `/work` disk-size cap.** Deferred: docker's local volume driver does not
  enforce size without a quota-backed filesystem, so it is non-portable. Tracked
  as a known gap in SECURITY.md.

## Consequences

- The footprint is bounded and predictable: `fixed + MAX_ACTIVE × memory cap`.
  The budget is an idle/light target; a single heavy tool run can still spike,
  and the per-agent cap protects the host if it goes too far.
- Conversations now have a loaded/stopped lifecycle. `listConversations` reports
  stopped conversations too (they still exist), with `running` and `busy` flags
  the UI surfaces ("N of M running", "Paused", "Working...").
- Switching is gated by an explicit `activate` step so the interrupt decision
  rides on plain HTTP, not the ws handshake; the ws path still starts a stopped
  container defensively.
- The defaults are conservative for low-spec machines; power users raise
  `HAKANAI_MAX_ACTIVE` / `HAKANAI_AGENT_MEMORY` / `HAKANAI_AGENT_CPUS` /
  `HAKANAI_AGENT_PIDS`.
