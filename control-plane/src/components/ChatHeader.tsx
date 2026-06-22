import { Trash2 } from "lucide-react";
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
    <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3 lg:px-8">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium tracking-tight">
          {activeConversation ? `Conversation ${activeConversation.id}` : "No conversation"}
        </h2>
        <StatusPill state={state} detail={detail} />
      </div>
      {activeConversation ? (
        <button
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
          Delete
        </button>
      ) : null}
    </header>
  );
}
