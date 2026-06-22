import { useCallback, useEffect, useMemo, useState } from "react";
import { createConversation, deleteConversation, listConversations } from "./api";
import { ChatHeader } from "./components/ChatHeader";
import { ChatThread } from "./components/ChatThread";
import { Sidebar } from "./components/Sidebar";
import type { Conversation } from "./types";

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Tool calls are hidden by default; the header toggle reveals them. Persisted
  // so the choice survives reloads.
  const [showTools, setShowTools] = useState(() => localStorage.getItem("hakanai:showTools") === "1");
  const toggleTools = useCallback(() => {
    setShowTools((on) => {
      const next = !on;
      localStorage.setItem("hakanai:showTools", next ? "1" : "0");
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const convs = await listConversations();
    setConversations(convs);
    return convs;
  }, []);

  useEffect(() => {
    refresh().then((convs) => {
      if (convs[0]) setActiveId(convs[0].id);
      else void handleCreateConversation();
    });
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreateConversation() {
    try {
      const id = await createConversation();
      await refresh();
      setActiveId(id);
    } catch (e) {
      console.error("create conversation failed:", e);
    }
  }

  async function handleDeleteConversation(id: string) {
    if (!confirm("Delete this conversation's container and disposable volume? This cannot be undone.")) return;
    await deleteConversation(id);
    const convs = await refresh();
    if (activeId === id) setActiveId(convs[0]?.id ?? null);
  }

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  );

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] overflow-hidden lg:grid-cols-[20.5rem_1fr] lg:grid-rows-1">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onNew={() => void handleCreateConversation()}
        onSelect={setActiveId}
        onDelete={(id) => void handleDeleteConversation(id)}
      />
      <main className={`flex h-full min-h-0 flex-col overflow-hidden bg-background${showTools ? "" : " hakanai-hide-tools"}`}>
        <ChatHeader
          activeConversation={activeConversation}
          onDelete={() => activeId && void handleDeleteConversation(activeId)}
          showTools={showTools}
          onToggleTools={toggleTools}
        />
        <div className="min-h-0 flex-1">
          {activeId ? (
            <ChatThread key={activeId} conversationId={activeId} onTitleRefresh={refresh} />
          ) : (
            <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">No active conversation</div>
          )}
        </div>
      </main>
    </div>
  );
}
