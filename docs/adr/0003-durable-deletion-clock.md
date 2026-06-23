# ADR-0003: A durable deletion clock

- **Status:** Accepted — 2026-06-23

## Context

The central promise is that a conversation is deleted after a TTL of inactivity
(default 3 days). The idle reaper enforces it from a `lastActivity` timestamp per
conversation. That timestamp lived only in control-plane memory, with a fallback
to the container's creation time on a cold start. So any control-plane restart
(a crash, a redeploy, a daemon restart) reset the clock: a conversation idle for
two days would get a fresh three-day lease. That silently extends retention,
which is exactly the thing the promise forbids, so "deleted after N days idle"
was not actually guaranteed.

The clock must therefore survive not just a restart but a multi-day outage:
while the control plane is down, nothing should be able to extend retention, and
on return the reaper should immediately delete anything already past its TTL.

## Decision

Persist the last-activity index to a small control-plane state volume
(`hakanai-state` mounted at `/state`, holding `activity.json`, a plain
`{conversationId: timestamp}` map). The in-memory map stays the hot path; the
file is a mirror.

The decisive property is **when** the timestamp is recorded: at activity time,
the moment we already mark the conversation active, not at stop or reap time.
That is the only thing correct across an outage, because the value was written
before the outage, nothing touches it while we are down, and on the next reaper
tick after we return, stale conversations are deleted.

Writes are split by frequency:

- **Discrete user actions flush immediately** (create, open/activate, upload,
  download, delete). These are human-paced and infrequent, so an immediate write
  is cheap and makes recency durable right away. Opening a conversation counts as
  activity and resets the clock (a deliberate, friendlier choice; the strict
  alternative of content-only can be revisited with stakeholders).
- **Streaming ws touches are flushed on the reaper tick** (every 60s) rather than
  per message. A streaming turn touches many times per second; persisting each
  would be needless I/O. Losing under a minute of recency on a hard crash is
  irrelevant to a three-day clock.

On boot the index is loaded and reconciled with the containers that actually
exist: a conversation present in docker but absent from the index (unknown to
us) gets a full lease so we never delete data we have no record for; index
entries with no container are pruned. A stale entry is kept as-is so the reaper
deletes it promptly.

The store holds only ids and timestamps, never conversation content (that lives
in each conversation's disposable volume and is destroyed on reap), so it does
not weaken the deletion boundary. Titles are deliberately kept out of it. A full
`./hakanai down` removes the state volume along with everything else.

The format and reconcile policy (serialize, parse-tolerantly, unknown-gets-lease,
orphan-pruned, stale-kept) are pinned by unit tests in `control-plane/activity.test.ts`
(`bun test`). The end-to-end guarantee is proven by `scripts/clock-smoke.sh`: a
conversation is touched, the control-plane container is force-recreated (wiping
its memory), and its last-activity must survive unchanged rather than reset to
creation time.

### Alternatives considered

- **Derive from Docker timestamps (`StartedAt` / `FinishedAt`).** Tempting
  because it needs no extra state. Rejected: "last run" is not "last used." A
  conversation that stays running under the active cap and is used daily keeps
  the same `StartedAt` (sending a prompt does not restart the container), so it
  would be wrongly reaped; and `FinishedAt` is only written when we stop a
  container, so a control-plane outage (when nothing stops idle containers)
  leaves the clock unset. Any signal written at stop time depends on the control
  plane being up to write it, which is the failure we are guarding against.
- **The `/work` volume's filesystem mtime.** Rejected: pi stores the chat
  transcript in the container layer (`/root/.pi`), not in `/work`, so a
  chat-only conversation never updates the volume's mtime and would be reaped
  while in active use.
- **A heartbeat file inside each conversation's volume.** Co-locates the record
  with the conversation, but the control plane does not mount per-conversation
  volumes, and writing one per activity would mean a `docker exec` per touch
  (and is impossible while a container is stopped). The single control-plane
  state volume is simpler.

## Consequences

- The deletion clock survives control-plane restarts, redeploys, and outages.
  The reaper and the LRU eviction (ADR-0002) both read the now-seeded map, so a
  cold start no longer mis-orders eviction either.
- One new named volume on the control plane, holding metadata only. It is noted
  in SECURITY.md and removed by `./hakanai down`.
- Recency can lag real activity by up to the reaper interval for a conversation
  whose only recent activity was mid-stream when the control plane crashed. This
  is immaterial against a multi-day TTL.
