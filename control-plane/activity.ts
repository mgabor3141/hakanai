// The durable deletion clock's pure core: how the last-activity index is
// serialized, parsed (tolerantly), and reconciled with reality on boot. The
// filesystem and write-coalescing glue lives in server.ts; this is the on-disk
// format and the reconcile policy, kept pure so it can be tested without docker.
// See docs/adr/0003-durable-deletion-clock.md.

export type ActivityIndex = Map<string, number>;

// On-disk form: { conversationId: epochMillis }.
export function serializeActivity(index: ActivityIndex): string {
  return JSON.stringify(Object.fromEntries(index));
}

// Parse the on-disk form back into an index, tolerantly. A corrupt or
// unexpected file yields an empty index rather than throwing -- the control
// plane must still boot -- and only finite-number timestamps survive, so a
// hand-edited or truncated file cannot inject junk entries.
export function parseActivity(text: string): ActivityIndex {
  const index: ActivityIndex = new Map();
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return index;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return index;
  for (const [id, ts] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof ts === "number" && Number.isFinite(ts)) index.set(id, ts);
  }
  return index;
}

// Reconcile a loaded index with the conversations that actually exist, in place:
//   - a conversation we have no record for gets a full lease (now), so we never
//     delete data we cannot date;
//   - an index entry with no conversation is pruned;
//   - a known entry is left untouched, so one already idle past its TTL (e.g.
//     while the control plane was down) is reaped promptly, not renewed.
export function reconcileActivity(index: ActivityIndex, existingIds: Iterable<string>, now: number): void {
  const ids = new Set(existingIds);
  for (const id of ids) if (!index.has(id)) index.set(id, now);
  for (const id of [...index.keys()]) if (!ids.has(id)) index.delete(id);
}
