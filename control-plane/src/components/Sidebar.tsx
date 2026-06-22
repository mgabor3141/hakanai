import clsx from "clsx";
import type { Conversation } from "../types";

function shortTime(ms: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

export function Sidebar({
  conversations,
  activeId,
  onNew,
  onSelect,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="flex h-full w-full flex-col border-r border-white/70 bg-white/70 p-5 shadow-xl shadow-slate-200/60 backdrop-blur-xl lg:w-[20.5rem]">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-slate-950 text-lg font-semibold text-white shadow-lg shadow-slate-300">
          儚
        </div>
        <div>
          <h1 className="text-base font-semibold tracking-tight text-slate-950">hakanai</h1>
          <p className="text-xs text-slate-500">Disposable private chats</p>
        </div>
      </div>

      <button
        className="mt-6 inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-950 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-slate-300 transition hover:-translate-y-0.5 hover:bg-slate-800"
        onClick={onNew}
      >
        <span className="text-lg leading-none">+</span> New conversation
      </button>

      <div className="mt-7 text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-slate-400">Conversations</div>
      <nav className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1" aria-label="Conversations">
        {conversations.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white/60 p-4 text-sm text-slate-500">
            No active workspaces
          </div>
        ) : (
          conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={clsx(
                "group w-full rounded-2xl border p-3 text-left transition",
                conversation.id === activeId
                  ? "border-blue-200 bg-blue-50 shadow-sm"
                  : "border-transparent bg-white/50 hover:border-slate-200 hover:bg-white",
              )}
              onClick={() => onSelect(conversation.id)}
            >
              <span className="block truncate text-sm font-medium text-slate-900">Conversation {conversation.id}</span>
              <span className="mt-1 block text-xs text-slate-500">Last active {shortTime(conversation.lastActivity)}</span>
            </button>
          ))
        )}
      </nav>

      <div className="mt-4 rounded-2xl border border-slate-200/80 bg-white/70 p-4 text-xs leading-5 text-slate-500">
        <strong className="block text-slate-700">Deletion boundary</strong>
        Each chat is one container plus one disposable volume.
      </div>
    </aside>
  );
}
