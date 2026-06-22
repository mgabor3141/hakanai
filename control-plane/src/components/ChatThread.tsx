import {
  AssistantRuntimeProvider,
  type AttachmentAdapter,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type ThreadMessageLike,
  useLocalRuntime,
} from "@assistant-ui/react";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AcpConnection, type AcpStatus, type HistoryMessage, type ToolCall } from "../acp";
import { uploadAttachment } from "../api";
import { ConversationFileContext } from "../conversationContext";
import { Thread } from "./assistant-ui/thread";
import { TooltipProvider } from "./ui/tooltip";

export function ChatThread({
  conversationId,
  onTitleRefresh,
}: {
  conversationId: string;
  onTitleRefresh: () => void;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [status, setStatus] = useState<AcpStatus>({ state: "connecting", detail: "Opening your private workspace..." });
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const connectionRef = useRef<AcpConnection | null>(null);

  // Keep the latest callback in a ref so the connection lifecycle depends only
  // on conversationId. Otherwise a new callback identity would tear down and
  // re-create the connection, and since each connect can fire onTitleRefresh,
  // that loops: reconnect -> refresh -> re-render -> reconnect.
  const onTitleRefreshRef = useRef(onTitleRefresh);
  onTitleRefreshRef.current = onTitleRefresh;

  useEffect(() => {
    const connection = new AcpConnection(conversationId, setStatus, () => onTitleRefreshRef.current());
    connectionRef.current = connection;
    let cancelled = false;
    setPhase("loading");

    connection
      .connect()
      .then((loaded) => {
        if (cancelled) return;
        setHistory(loaded);
        setPhase("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPhase("error");
      });

    return () => {
      cancelled = true;
      connection.close();
      connectionRef.current = null;
    };
  }, [conversationId]);

  if (phase === "loading") return <LoadingState detail={status.detail} />;
  if (phase === "error") return <ErrorState />;
  return (
    <ChatRuntime
      conversationId={conversationId}
      connection={connectionRef.current!}
      initialMessages={history.map(toThreadMessage)}
    />
  );
}

function ChatRuntime({
  conversationId,
  connection,
  initialMessages,
}: {
  conversationId: string;
  connection: AcpConnection;
  initialMessages: ThreadMessageLike[];
}) {
  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages }) {
        const prompt = promptFromMessage(messages.at(-1));
        const stream = await connection.promptStream(prompt);
        // Build the assistant turn as ordered parts: text accumulates into the
        // trailing text part; each tool call is upserted in place by id so its
        // args/result fill in as ACP streams updates.
        const parts: ChatPart[] = [];
        const toolAt = new Map<string, number>();
        for await (const ev of stream) {
          if (ev.kind === "text") {
            const last = parts[parts.length - 1];
            if (last?.type === "text") last.text += ev.delta;
            else parts.push({ type: "text", text: ev.delta });
          } else {
            const at = toolAt.get(ev.tool.id);
            if (at !== undefined) parts[at] = { type: "tool", tool: ev.tool };
            else {
              toolAt.set(ev.tool.id, parts.length);
              parts.push({ type: "tool", tool: ev.tool });
            }
          }
          yield { content: parts.map(toContentPart) } as ChatModelRunResult;
        }
      },
    }),
    [connection],
  );

  // Attachments are written into this conversation's container, not sent to the
  // model. `send` uploads the file and hands the agent a path it can read.
  const attachments = useMemo<AttachmentAdapter>(
    () => ({
      // Accept any file: it is written into the container for the agent to
      // handle (spreadsheets, archives, audio, etc.), not sent to the model as
      // an attachment. "*" is the matcher's only true match-all ("*/*" fails).
      accept: "*",
      async add({ file }) {
        return {
          id: crypto.randomUUID(),
          type: file.type.startsWith("image/") ? "image" : "file",
          name: file.name,
          contentType: file.type || undefined,
          file,
          status: { type: "requires-action", reason: "composer-send" },
        };
      },
      async send(attachment) {
        const path = await uploadAttachment(conversationId, attachment.file);
        return {
          ...attachment,
          status: { type: "complete" },
          content: [{ type: "text", text: `Attached file "${attachment.name}" saved in this workspace at: ${path}` }],
        };
      },
      async remove() {},
    }),
    [conversationId],
  );

  const runtime = useLocalRuntime(adapter, { initialMessages, adapters: { attachments } });

  return (
    <ConversationFileContext.Provider value={conversationId}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TooltipProvider delayDuration={300}>
          <Thread components={{ Welcome }} />
        </TooltipProvider>
      </AssistantRuntimeProvider>
    </ConversationFileContext.Provider>
  );
}

function LoadingState({ detail }: { detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="size-6 animate-spin text-primary" />
      <p className="text-sm">{detail ?? "Opening your private workspace..."}</p>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
      <p>This conversation could not be opened. It may have been deleted.</p>
    </div>
  );
}

function Welcome() {
  return (
    <div className="mb-8 flex flex-col items-center px-4 text-center">
      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-col items-center gap-3 duration-300">
        <span className="text-3xl leading-none text-primary/70 select-none">儚</span>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">A fresh, private workspace</h1>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
          This chat lives in its own sealed container. Nothing leaves it, and when you delete the conversation it is gone for good.
        </p>
      </div>
    </div>
  );
}

type ChatPart = { type: "text"; text: string } | { type: "tool"; tool: ToolCall };

// Map our internal parts to assistant-ui content parts. Tool calls become
// tool-call parts, which the Thread renders via the collapsible tool group.
function toContentPart(part: ChatPart) {
  if (part.type === "text") return { type: "text" as const, text: part.text };
  const t = part.tool;
  let args: Record<string, unknown> = {};
  if (t.argsText) {
    try {
      args = JSON.parse(t.argsText);
    } catch {
      // leave args empty; argsText still shows the raw input
    }
  }
  return {
    type: "tool-call" as const,
    toolCallId: t.id,
    toolName: t.name,
    args,
    argsText: t.argsText ?? "",
    ...(t.resultText !== undefined ? { result: t.resultText } : {}),
    ...(t.status === "error" ? { isError: true } : {}),
  };
}

function toThreadMessage(message: HistoryMessage): ThreadMessageLike {
  return { role: message.role, content: [{ type: "text", text: message.text }] };
}

// The typed text lives in message.content; attachment paths live in
// message.attachments[].content (assistant-ui keeps them separate). Fold both
// into one prompt so the agent sees the question and the file paths together.
function promptFromMessage(message: unknown): string {
  const m = message as { content?: unknown; attachments?: { content?: unknown }[] };
  const parts = [textOfParts(m?.content)];
  for (const attachment of m?.attachments ?? []) parts.push(textOfParts(attachment?.content));
  return parts.filter(Boolean).join("\n\n").trim();
}

function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}
