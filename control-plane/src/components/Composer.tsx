import type { FormEvent, KeyboardEvent } from "react";
import type { ConnectionState } from "../types";

export function Composer({
  value,
  state,
  detail,
  canSend,
  onChange,
  onSubmit,
}: {
  value: string;
  state: ConnectionState;
  detail: string;
  canSend: boolean;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit(event as unknown as FormEvent);
    }
  }

  return (
    <form className="border-t border-slate-200/70 bg-white/80 px-5 py-4 backdrop-blur-xl lg:px-8" onSubmit={onSubmit}>
      <div className="mx-auto flex max-w-4xl items-end gap-3 rounded-[1.6rem] border border-slate-200 bg-white p-2 shadow-xl shadow-slate-200/70 focus-within:border-blue-300 focus-within:ring-4 focus-within:ring-blue-100">
        <textarea
          id="hakanai-message"
          name="message"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={state === "ready" ? "Ask anything. This stays inside the disposable workspace." : detail}
          disabled={state !== "ready"}
          rows={1}
          className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-3 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
        />
        <button
          className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-medium text-white shadow-md shadow-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canSend}
        >
          Send
        </button>
      </div>
    </form>
  );
}
