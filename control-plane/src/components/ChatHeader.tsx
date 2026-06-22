import { StatusPill } from "./status";
import type { ConnectionState, Conversation } from "../types";

export function ChatHeader({
  activeConversation,
  state,
  detail,
  onDelete,
}: {
  activeConversation: Conversation | null;
  state: ConnectionState;
  detail: string;
  onDelete: () => void;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-slate-200/70 bg-white/80 px-5 py-4 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between lg:px-8">
      <div>
        <div className="text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-slate-400">Private workspace</div>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
          {activeConversation ? `Conversation ${activeConversation.id}` : "No conversation"}
        </h2>
      </div>
      <div className="flex items-center gap-2">
        <StatusPill state={state} detail={detail} />
        {activeConversation ? (
          <button
            className="rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 shadow-sm transition hover:bg-rose-50"
            onClick={onDelete}
          >
            Delete
          </button>
        ) : null}
      </div>
    </header>
  );
}
