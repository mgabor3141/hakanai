import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ChatModelAdapter,
  useLocalRuntime,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef } from "react";
import { AcpConnection, type AcpStatus } from "../acp";

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
        return { content: [{ type: "text", text }] };
      },
    };
  }, [conversationId, onStatus]);

  useEffect(() => {
    connectionRef.current?.connect().catch((error) => onStatus({ state: "error", detail: String(error.message ?? error) }));
    return () => connectionRef.current?.close();
  }, [conversationId, onStatus]);

  const runtime = useLocalRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="flex-1 space-y-4 overflow-y-auto p-6" autoScroll>
          <ThreadPrimitive.Empty>
            <Welcome />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, SystemMessage }} />
        </ThreadPrimitive.Viewport>
        <Composer />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
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

function Welcome() {
  return (
    <div className="mx-auto max-w-xl rounded-2xl border bg-white p-6 text-center shadow-sm">
      <h3 className="text-xl font-semibold">What should we work on?</h3>
      <p className="mt-2 text-sm text-slate-600">
        This conversation runs in its own locked-down container. Delete it when you are done and the workspace volume goes with it.
      </p>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-3xl rounded-2xl bg-slate-950 px-4 py-3 text-sm leading-6 text-white">
        <MessagePrimitive.Content />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="max-w-3xl rounded-2xl border bg-white px-4 py-3 text-sm leading-6 text-slate-900 shadow-sm">
        <MessagePrimitive.Content />
      </div>
    </MessagePrimitive.Root>
  );
}

function SystemMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-center">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <MessagePrimitive.Content />
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="border-t bg-white/80 p-4">
      <div className="mx-auto flex max-w-4xl gap-2 rounded-2xl border bg-white p-2 shadow-sm">
        <ComposerPrimitive.Input
          id="hakanai-message"
          name="message"
          className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-3 text-sm outline-none placeholder:text-slate-400 disabled:text-slate-400"
          placeholder="Ask anything. This stays inside the disposable workspace."
        />
        <ComposerPrimitive.Send className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
          Send
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}
