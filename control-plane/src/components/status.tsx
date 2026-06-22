import { cn } from "@/lib/utils";
import type { ConnectionState } from "../types";

export function statusLabel(state: ConnectionState) {
  if (state === "connecting") return "Connecting";
  if (state === "ready") return "Ready";
  if (state === "thinking") return "Thinking";
  if (state === "error") return "Needs attention";
  return "Idle";
}

export function StatusPill({ state, detail }: { state: ConnectionState; detail: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" title={detail}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "ready" && "bg-emerald-500",
          state === "thinking" && "animate-pulse bg-primary",
          state === "connecting" && "animate-pulse bg-amber-500",
          state === "error" && "bg-destructive",
          state === "idle" && "bg-muted-foreground/40",
        )}
      />
      {statusLabel(state)}
    </span>
  );
}
