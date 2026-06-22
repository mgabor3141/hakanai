import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createConversation, deleteConversation, listConversations } from "./api";
import { AcpConnection, newMessageId } from "./acp";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { Messages } from "./components/Messages";
import { Sidebar } from "./components/Sidebar";
import { statusLabel } from "./components/status";
import { forgetMessages, loadMessages, saveMessages } from "./storage";
import type { ConnectionState, Conversation, Message } from "./types";

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<ConnectionState>("idle");
  const [detail, setDetail] = useState("Choose or start a conversation");
  const [draft, setDraft] = useState("");
  const connRef = useRef<AcpConnection | null>(null);

  useEffect(() => {
    if (activeId) saveMessages(activeId, messages);
  }, [activeId, messages]);

  useEffect(() => {
    refreshConversations().then((convs) => {
      if (convs.length > 0) void selectConversation(convs[0].id);
      else void handleCreateConversation();
    });
    const timer = window.setInterval(() => void refreshConversations(), 20_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshConversations() {
    const convs = await listConversations();
    setConversations(convs);
    return convs;
  }

  async function handleCreateConversation() {
    setState("connecting");
    setDetail("Creating a disposable workspace...");
    try {
      const id = await createConversation();
      await refreshConversations();
      await selectConversation(id, []);
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  }

  async function selectConversation(id: string, initialMessages = loadMessages(id)) {
    connRef.current?.close();
    connRef.current = null;
    setActiveId(id);
    setMessages(initialMessages);

    const conn = new AcpConnection(id, (event) => {
      if (event.type === "state") {
        setState(event.state);
        setDetail(event.detail ?? statusLabel(event.state));
        return;
      }
      if (event.type === "assistant-delta") appendAssistantDelta(event.text);
      if (event.type === "system") addSystemMessage(event.text);
    });
    connRef.current = conn;

    try {
      await conn.connect();
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  }

  async function handleDeleteConversation(id: string) {
    if (!confirm("Delete this conversation's container and disposable volume? This cannot be undone.")) return;
    if (activeId === id) connRef.current?.close();
    await deleteConversation(id);
    forgetMessages(id);
    const convs = await refreshConversations();
    if (activeId === id) {
      setActiveId(null);
      setMessages([]);
      setState("idle");
      setDetail("Conversation deleted");
      if (convs.length > 0) await selectConversation(convs[0].id);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !connRef.current || state !== "ready") return;

    setDraft("");
    setMessages((prev) => [...prev, { id: newMessageId(), role: "user", text }]);
    try {
      await connRef.current.prompt(text);
      settlePendingAssistantMessage();
      await refreshConversations();
    } catch (err) {
      setState("error");
      setDetail((err as Error).message);
      addSystemMessage(`Prompt failed: ${(err as Error).message}`);
    }
  }

  function appendAssistantDelta(text: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.pending) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: newMessageId(), role: "assistant", text, pending: true }];
    });
  }

  function settlePendingAssistantMessage() {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.pending) return [...prev.slice(0, -1), { ...last, pending: false }];
      return prev;
    });
  }

  function addSystemMessage(text: string) {
    setMessages((prev) => [...prev, { id: newMessageId(), role: "system", text }]);
  }

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  );
  const canSend = state === "ready" && draft.trim().length > 0;

  return (
    <div className="grid min-h-screen grid-rows-[auto_1fr] lg:grid-cols-[20.5rem_1fr] lg:grid-rows-1">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onNew={() => void handleCreateConversation()}
        onSelect={(id) => void selectConversation(id)}
      />
      <main className="flex min-h-screen flex-col overflow-hidden">
        <ChatHeader
          activeConversation={activeConversation}
          state={state}
          detail={detail}
          onDelete={() => activeId && void handleDeleteConversation(activeId)}
        />
        <Messages messages={messages} thinking={state === "thinking"} />
        <Composer value={draft} state={state} detail={detail} canSend={canSend} onChange={setDraft} onSubmit={send} />
      </main>
    </div>
  );
}
