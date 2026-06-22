import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { conversationTitle } from "../conversation";
import { isFadingSoon, relativeActive } from "../fade";
import type { Conversation } from "../types";

export function Sidebar({
  conversations,
  activeId,
  onNew,
  onSelect,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="flex h-full w-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <span className="grid size-9 place-items-center rounded-xl bg-primary/10 text-lg leading-none text-primary select-none">
          儚
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight">hakanai</h1>
          <p className="text-xs text-muted-foreground">Disposable private chats</p>
        </div>
      </div>

      <div className="px-3">
        <button
          className="inline-flex w-full items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          onClick={onNew}
        >
          <Plus className="size-4" />
          New conversation
        </button>
      </div>

      <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Conversations">
        {conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No active workspaces</p>
        ) : (
          conversations.map((conversation) => {
            const active = conversation.id === activeId;
            return (
              <div
                key={conversation.id}
                className={cn(
                  "group flex items-center gap-2 rounded-lg pe-1.5 transition-colors",
                  active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
                )}
              >
                <button
                  className="flex min-w-0 flex-1 flex-col items-start px-2.5 py-2 text-left"
                  onClick={() => onSelect(conversation.id)}
                >
                  <span className={cn("w-full truncate text-sm", active ? "font-medium" : "text-foreground/90")}>
                    {conversationTitle(conversation)}
                  </span>
                  {isFadingSoon(conversation.expiresAt) ? (
                    <span className="text-xs font-medium text-primary">Deletes soon</span>
                  ) : (
                    <span className="text-xs text-muted-foreground capitalize">{relativeActive(conversation.lastActivity)}</span>
                  )}
                </button>
                <button
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => onDelete(conversation.id)}
                  aria-label={`Delete conversation ${conversation.id}`}
                  title="Delete conversation"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            );
          })
        )}
      </nav>
    </aside>
  );
}
