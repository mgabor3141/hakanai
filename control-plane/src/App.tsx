import { useCallback, useEffect, useMemo, useState } from "react";
import { createConversation, deleteConversation, listConversations } from "./api";
import { ChatHeader } from "./components/ChatHeader";
import { ChatThread } from "./components/ChatThread";
import { Sidebar } from "./components/Sidebar";
import { statusLabel } from "./components/status";
import type { AcpStatus } from "./acp";
import type { ConnectionState, Conversation } from "./types";

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [detail, setDetail] = useState("Choose or start a conversation");

  const refresh = useCallback(async () => {
    const convs = await listConversations();
    setConversations(convs);
    return convs;
  }, []);

  const selectConversation = useCallback((id: string) => {
    setActiveId(id);
    setState("connecting");
    setDetail("Connecting");
  }, []);

  const onStatus = useCallback((status: AcpStatus) => {
    setState(status.state);
    setDetail(status.detail ?? statusLabel(status.state));
  }, []);

  useEffect(() => {
    refresh().then((convs) => {
      if (convs[0]) selectConversation(convs[0].id);
      else void handleCreateConversation();
    });
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreateConversation() {
    setState("connecting");
    setDetail("Creating a disposable workspace...");
    try {
      const id = await createConversation();
      await refresh();
      selectConversation(id);
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  }

  async function handleDeleteConversation(id: string) {
    if (!confirm("Delete this conversation's container and disposable volume? This cannot be undone.")) return;
    await deleteConversation(id);
    const convs = await refresh();
    if (activeId === id) {
      const next = convs[0]?.id;
      if (next) selectConversation(next);
      else {
        setActiveId(null);
        setState("idle");
        setDetail("Conversation deleted");
      }
    }
  }

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  );

  return (
    <div className="grid min-h-screen grid-rows-[auto_1fr] lg:grid-cols-[20.5rem_1fr] lg:grid-rows-1">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onNew={() => void handleCreateConversation()}
        onSelect={selectConversation}
        onDelete={(id) => void handleDeleteConversation(id)}
      />
      <main className="flex min-h-screen flex-col overflow-hidden bg-background">
        <ChatHeader
          activeConversation={activeConversation}
          state={state}
          detail={detail}
          onDelete={() => activeId && void handleDeleteConversation(activeId)}
        />
        <div className="min-h-0 flex-1">
          {activeId ? (
            <ChatThread key={activeId} conversationId={activeId} onStatus={onStatus} />
          ) : (
            <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">No active conversation</div>
          )}
        </div>
      </main>
    </div>
  );
}
