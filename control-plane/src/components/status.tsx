import clsx from "clsx";
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
    <div
      className={clsx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium shadow-sm",
        state === "ready" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        state === "thinking" && "border-blue-200 bg-blue-50 text-blue-700",
        state === "connecting" && "border-amber-200 bg-amber-50 text-amber-700",
        state === "error" && "border-rose-200 bg-rose-50 text-rose-700",
        state === "idle" && "border-slate-200 bg-white text-slate-600",
      )}
      title={detail}
    >
      <span
        className={clsx(
          "h-2 w-2 rounded-full",
          state === "ready" && "bg-emerald-500",
          state === "thinking" && "animate-pulse bg-blue-500",
          state === "connecting" && "animate-pulse bg-amber-500",
          state === "error" && "bg-rose-500",
          state === "idle" && "bg-slate-400",
        )}
      />
      {statusLabel(state)}
    </div>
  );
}
