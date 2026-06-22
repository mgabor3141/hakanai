import clsx from "clsx";
import type { Message } from "../types";

export function Messages({ messages, thinking }: { messages: Message[]; thinking: boolean }) {
  return (
    <section className="flex-1 space-y-6 overflow-y-auto px-5 py-8 lg:px-8" aria-live="polite">
      {messages.length === 0 ? <Welcome /> : messages.map((message) => <Bubble key={message.id} message={message} />)}
      {thinking ? <Typing /> : null}
    </section>
  );
}

function Welcome() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center rounded-[2rem] border border-white/80 bg-white/70 p-8 text-center shadow-xl shadow-slate-200/70 backdrop-blur-xl">
      <div className="mb-5 h-16 w-16 rounded-full bg-gradient-to-br from-blue-500 via-indigo-500 to-fuchsia-500 shadow-xl shadow-blue-200" />
      <h3 className="text-2xl font-semibold tracking-tight text-slate-950">What should we work on?</h3>
      <p className="mt-3 max-w-lg text-sm leading-6 text-slate-600">
        This conversation runs in its own locked-down container. Delete it when you are done and the workspace volume goes with it.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2 text-xs font-medium text-slate-600">
        <span className="rounded-full bg-slate-100 px-3 py-1.5">Summarize this</span>
        <span className="rounded-full bg-slate-100 px-3 py-1.5">Draft an email</span>
        <span className="rounded-full bg-slate-100 px-3 py-1.5">Explain a document</span>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  return (
    <article className={clsx("flex gap-3", message.role === "user" && "flex-row-reverse")}> 
      <div
        className={clsx(
          "grid h-9 w-9 shrink-0 place-items-center rounded-full text-[0.7rem] font-semibold shadow-sm",
          message.role === "user" && "bg-slate-950 text-white",
          message.role === "assistant" && "bg-white text-blue-700 ring-1 ring-blue-100",
          message.role === "system" && "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
        )}
      >
        {message.role === "user" ? "You" : message.role === "assistant" ? "AI" : "!"}
      </div>
      <div
        className={clsx(
          "max-w-3xl rounded-[1.4rem] px-4 py-3 text-sm leading-6 shadow-sm",
          message.role === "user" && "bg-slate-950 text-white",
          message.role === "assistant" && "border border-slate-200 bg-white text-slate-800",
          message.role === "system" && "border border-amber-200 bg-amber-50 text-amber-800",
        )}
      >
        <div className="whitespace-pre-wrap">{message.text}</div>
      </div>
    </article>
  );
}

function Typing() {
  return (
    <div className="ml-12 inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-2 shadow-sm" aria-label="Assistant is thinking">
      <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.2s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.1s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400" />
    </div>
  );
}
