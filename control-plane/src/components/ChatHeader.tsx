import { Trash2 } from "lucide-react";
import { conversationTitle } from "../conversation";
import type { Conversation } from "../types";

export function ChatHeader({
  activeConversation,
  onDelete,
}: {
  activeConversation: Conversation | null;
  onDelete: () => void;
}) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3 lg:px-8">
      <h2 className="min-w-0 truncate text-sm font-medium tracking-tight">
        {activeConversation ? conversationTitle(activeConversation) : "No conversation"}
      </h2>
      {activeConversation ? (
        <button
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
          Delete
        </button>
      ) : null}
    </header>
  );
}
