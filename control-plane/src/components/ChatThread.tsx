import { AssistantRuntimeProvider, type ChatModelAdapter, useLocalRuntime } from "@assistant-ui/react";
import { useEffect, useMemo, useRef } from "react";
import { AcpConnection, type AcpStatus } from "../acp";
import { Thread } from "./assistant-ui/thread";
import { TooltipProvider } from "./ui/tooltip";

export function ChatThread({ conversationId, onStatus }: { conversationId: string; onStatus: (status: AcpStatus) => void }) {
  const connectionRef = useRef<AcpConnection | null>(null);

  const adapter = useMemo<ChatModelAdapter>(() => {
    const connection = new AcpConnection(conversationId, onStatus);
    connectionRef.current = connection;

    return {
      async *run({ messages }) {
        const prompt = textFromMessage(messages.at(-1));
        const stream = await connection.promptStream(prompt);
        let text = "";
        for await (const delta of stream) {
          text += delta;
          yield { content: [{ type: "text", text }] };
        }
      },
    };
  }, [conversationId, onStatus]);

  useEffect(() => {
    connectionRef.current?.connect().catch((error) => onStatus({ state: "error", detail: String(error?.message ?? error) }));
    return () => connectionRef.current?.close();
  }, [conversationId, onStatus]);

  const runtime = useLocalRuntime(adapter);

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

function textFromMessage(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("\n")
    .trim();
}
