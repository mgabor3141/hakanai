import { useCallback, useEffect, useMemo, useState } from "react";
import { activateConversation, createConversation, deleteConversation, getConfig, isAtCapacity, listConversations } from "./api";
import { ChatHeader } from "./components/ChatHeader";
import { ChatThread } from "./components/ChatThread";
import { InterruptDialog, type InterruptPrompt } from "./components/InterruptDialog";
import { SettingsDialog } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { conversationTitle } from "./conversation";
import type { Conversation } from "./types";

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [maxActive, setMaxActive] = useState(2);
  const [interrupt, setInterrupt] = useState<InterruptPrompt | null>(null);
  const [configured, setConfigured] = useState(true); // assume true until /api/config says otherwise (avoids a flash)
  const [vertexModels, setVertexModels] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = useCallback(async () => {
    const convs = await listConversations();
    setConversations(convs);
    return convs;
  }, []);

  const loadConfig = useCallback(async () => {
    const c = await getConfig().catch(() => null);
    if (!c) return null;
    setMaxActive(c.maxActive);
    setConfigured(c.configured);
    setVertexModels(c.vertexModels ?? []);
    return c;
  }, []);

  useEffect(() => {
    loadConfig().then((c) => {
      refresh().then((convs) => {
        if (convs[0]) setActiveId(convs[0].id);
        // Only auto-create a first conversation once a provider is configured.
        else if (c?.configured) void handleCreateConversation();
        else setSettingsOpen(true); // first run: nudge the user to configure a model
      });
    });
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Name a would-be-interrupted conversation for the dialog (it may not be the
  // active one). Falls back to a generic label.
  const titleOf = useCallback(
    (id: string) => {
      const c = conversations.find((x) => x.id === id);
      return c ? conversationTitle(c) : "Another chat";
    },
    [conversations],
  );

  async function handleCreateConversation(force = false) {
    try {
      const res = await createConversation(force);
      if (isAtCapacity(res)) {
        setInterrupt({
          action: "new",
          otherTitle: res.wouldInterrupt.title ?? titleOf(res.wouldInterrupt.id),
          onConfirm: () => {
            setInterrupt(null);
            void handleCreateConversation(true);
          },
        });
        return;
      }
      await refresh();
      setActiveId(res);
    } catch (e) {
      console.error("create conversation failed:", e);
    }
  }

  // Switch to a conversation, loading it within the budget first. If that would
  // interrupt a busy chat, ask before forcing it.
  async function handleSelect(id: string, force = false) {
    if (id === activeId && !force) return;
    try {
      const res = await activateConversation(id, force);
      if (isAtCapacity(res)) {
        setInterrupt({
          action: "switch",
          otherTitle: res.wouldInterrupt.title ?? titleOf(res.wouldInterrupt.id),
          onConfirm: () => {
            setInterrupt(null);
            void handleSelect(id, true);
          },
        });
        return;
      }
      setActiveId(id);
      void refresh();
    } catch (e) {
      console.error("activate conversation failed:", e);
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
  const runningCount = useMemo(() => conversations.filter((c) => c.running).length, [conversations]);

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] overflow-hidden lg:grid-cols-[20.5rem_1fr] lg:grid-rows-1">
      <InterruptDialog prompt={interrupt} onCancel={() => setInterrupt(null)} />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        vertexModels={vertexModels}
        onSaved={() => void loadConfig().then(() => refresh())}
      />
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        runningCount={runningCount}
        maxActive={maxActive}
        configured={configured}
        onNew={() => void handleCreateConversation()}
        onSelect={(id) => void handleSelect(id)}
        onDelete={(id) => void handleDeleteConversation(id)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <ChatHeader activeConversation={activeConversation} onDelete={() => activeId && void handleDeleteConversation(activeId)} />
        <div className="min-h-0 flex-1">
          {activeId ? (
            <ChatThread key={activeId} conversationId={activeId} onTitleRefresh={refresh} />
          ) : configured ? (
            <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">No active conversation</div>
          ) : (
            <div className="grid h-full place-items-center p-6">
              <div className="max-w-sm text-center">
                <p className="text-sm font-medium">Configure a model to get started</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pick an OpenAI-compatible endpoint or Google Vertex, then start chatting.
                </p>
                <button
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  onClick={() => setSettingsOpen(true)}
                >
                  Open Settings
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
