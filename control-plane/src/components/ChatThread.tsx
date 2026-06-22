import {
  AssistantRuntimeProvider,
  type AttachmentAdapter,
  type ChatModelAdapter,
  useLocalRuntime,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef } from "react";
import { AcpConnection, type AcpStatus } from "../acp";
import { uploadAttachment } from "../api";
import { Thread } from "./assistant-ui/thread";
import { TooltipProvider } from "./ui/tooltip";

export function ChatThread({ conversationId, onStatus }: { conversationId: string; onStatus: (status: AcpStatus) => void }) {
  const connectionRef = useRef<AcpConnection | null>(null);

  const adapter = useMemo<ChatModelAdapter>(() => {
    const connection = new AcpConnection(conversationId, onStatus);
    connectionRef.current = connection;

    return {
      async *run({ messages }) {
        const prompt = promptFromMessage(messages.at(-1));
        const stream = await connection.promptStream(prompt);
        let text = "";
        for await (const delta of stream) {
          text += delta;
          yield { content: [{ type: "text", text }] };
        }
      },
    };
  }, [conversationId, onStatus]);

  // Attachments are written into this conversation's container, not sent to the
  // model. `send` uploads the file and hands the agent a path it can read.
  const attachments = useMemo<AttachmentAdapter>(
    () => ({
      accept: "image/*,text/*,application/pdf,application/json",
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

  useEffect(() => {
    connectionRef.current?.connect().catch((error) => onStatus({ state: "error", detail: String(error?.message ?? error) }));
    return () => connectionRef.current?.close();
  }, [conversationId, onStatus]);

  const runtime = useLocalRuntime(adapter, { adapters: { attachments } });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider delayDuration={300}>
        <Thread components={{ Welcome }} />
      </TooltipProvider>
    </AssistantRuntimeProvider>
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
