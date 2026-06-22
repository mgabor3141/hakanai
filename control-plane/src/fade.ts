// The idle reaper deletes a conversation once it has been untouched past the
// TTL (default 3 days). These helpers turn the server's `expiresAt` into calm,
// approximate copy. The clock is soft (any activity resets it, and it restarts
// if the control plane restarts), so we never show a hard ticking countdown.

const HOUR = 3_600_000;
const DAY = 86_400_000;
const SOON_MS = 12 * HOUR;

// Approximate, neutral phrase for the header: "Auto-deletes in about 3 days".
export function fadeLabel(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "Auto-deletes any moment now";
  if (ms < HOUR) return "Auto-deletes in under an hour";
  if (ms < DAY) {
    const hours = Math.round(ms / HOUR);
    return `Auto-deletes in about ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(ms / DAY);
  return `Auto-deletes in about ${days} day${days === 1 ? "" : "s"}`;
}

// Fuller, still-honest phrasing for the hover tooltip.
export function fadeExact(expiresAt: number): string {
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(expiresAt));
  return `If left untouched, this conversation is deleted around ${when}. Using it resets the clock.`;
}

// True when deletion is close (or already due), so a row can flag it.
export function isFadingSoon(expiresAt: number, now = Date.now()): boolean {
  return expiresAt - now < SOON_MS;
}

// Relative "last active" for sidebar rows. Absolute clock times get ambiguous
// once a conversation is a day or two old.
export function relativeActive(ts: number, now = Date.now()): string {
  const ms = now - ts;
  if (ms < 60_000) return "active just now";
  if (ms < HOUR) return `active ${Math.round(ms / 60_000)}m ago`;
  if (ms < DAY) return `active ${Math.round(ms / HOUR)}h ago`;
  return `active ${Math.round(ms / DAY)}d ago`;
}
