# Architecture decisions

Lightweight ADRs, one decision per file, in the spirit of hako's. The project is
still prototyping, so an ADR may be edited in place when a decision changes
(rather than kept as a supersession chain); the status line notes what changed.

These are forward-looking: they capture decisions as we make them. The current
state of the security model as a whole lives in [SECURITY.md](../../SECURITY.md);
ADRs explain *why* a given enforcement was chosen and what was rejected.

- [0001](0001-cross-conversation-isolation.md) — Cross-conversation isolation: per-conversation networks + a frontend-bound control-plane API
- [0002](0002-memory-budget.md) — A single-machine memory budget: bounded concurrency + per-agent resource caps
- [0003](0003-durable-deletion-clock.md) — A durable deletion clock: persist last-activity so a restart cannot extend the TTL
- [0004](0004-browser-origin-guard.md) — A browser-origin guard: Host + Origin checks defeat CSRF and DNS rebinding from the user's own browser
