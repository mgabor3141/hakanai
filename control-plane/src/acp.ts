import type { ConnectionState } from "./types";

export type AcpStatus = { state: ConnectionState; detail?: string };
export type HistoryMessage = { role: "user" | "assistant"; text: string };

// A tool the agent invoked during a turn, as surfaced to the UI.
export type ToolCall = {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  argsText?: string;
  resultText?: string;
};

// What promptStream yields: assistant text deltas, and tool-call snapshots
// (each snapshot is the merged current state of one tool call).
export type StreamEvent = { kind: "text"; delta: string } | { kind: "tool"; tool: ToolCall };

const CWD = "/work";

type SessionUpdate = {
  sessionUpdate?: string;
  content?: unknown; // { text } for message chunks; an array for tool calls
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
};

type RpcMessage = {
  id?: number;
  method?: string;
  params?: { update?: SessionUpdate };
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

type SessionListResult = {
  sessions?: { sessionId: string; cwd?: string; updatedAt?: string }[];
};

type StreamQueue = {
  push(event: StreamEvent): void;
  close(): void;
  fail(error: unknown): void;
  stream(): AsyncGenerator<StreamEvent>;
};

export class AcpConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, (m: RpcMessage) => void>();
  private buffer = "";
  private sessionId: string | null = null;
  private connecting: Promise<HistoryMessage[]> | null = null;
  private activeStream: StreamQueue | null = null;
  private closed = false;

  // Load-replay state. session/load streams the conversation back as
  // session/update notifications; we collect them here and rebuild history.
  private loadingHistory = false;
  private replay: HistoryMessage[] = [];
  private bumpReplay: (() => void) | null = null;

  // Merged tool-call state for the current turn, keyed by toolCallId. ACP
  // streams a tool call as one tool_call then many tool_call_update notes that
  // fill in args/result; we merge them and emit the running snapshot.
  private toolStates = new Map<string, ToolCall>();

  constructor(
    private readonly conversationId: string,
    private readonly setStatus: (status: AcpStatus) => void,
    // Fired when the session title may have changed (after connecting, and
    // after each turn). The caller re-fetches the conversation list, whose
    // titles the control plane snoops off our session/list calls.
    private readonly onTitleRefresh: () => void = () => {},
  ) {}

  // Resolves with the conversation's prior messages (empty for a new chat).
  connect(): Promise<HistoryMessage[]> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openAndInitialize();
    return this.connecting;
  }

  async promptStream(text: string): Promise<AsyncGenerator<StreamEvent>> {
    await this.connect();
    if (!this.sessionId) throw new Error("No active ACP session");

    this.toolStates.clear();
    const queue = createStreamQueue();
    this.activeStream = queue;
    this.setStatus({ state: "thinking" });

    void this.rpc("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    })
      .then((res) => {
        if (res.error) queue.fail(new Error(res.error.message ?? JSON.stringify(res.error)));
        else queue.close();
      })
      .catch((error) => queue.fail(error))
      .finally(() => {
        if (this.activeStream === queue) this.activeStream = null;
        if (!this.closed) this.setStatus({ state: "ready" });
        // The agent may have just auto-named the session; nudge a title refresh.
        void this.refreshTitle();
      });

    return queue.stream();
  }

  close(): void {
    this.closed = true;
    this.activeStream?.close();
    for (const resolve of this.pending.values()) resolve({ error: { message: "closed" } });
    this.pending.clear();
    this.ws?.close();
  }

  private async openAndInitialize(): Promise<HistoryMessage[]> {
    this.setStatus({ state: "connecting", detail: "Starting secure workspace..." });
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/api/conversations/${this.conversationId}/ws`);
    this.ws = ws;

    ws.addEventListener("message", (ev) => {
      this.buffer = drain(this.buffer + String(ev.data), (m) => this.route(m));
    });
    ws.addEventListener("close", () => {
      if (!this.closed) this.setStatus({ state: "error", detail: "Connection closed" });
    });
    ws.addEventListener("error", () => this.setStatus({ state: "error", detail: "Connection failed" }));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
    });

    this.setStatus({ state: "connecting", detail: "Introducing the browser to the agent..." });
    await this.rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });

    // The conversation's history lives in the container. Resume the existing
    // session (replaying it) instead of starting a blank one; only start fresh
    // if this container has never been prompted.
    const existing = await this.findExistingSession();
    if (existing) {
      const history = await this.loadSession(existing);
      this.setStatus({ state: "ready" });
      this.onTitleRefresh();
      return history;
    }

    await this.newSession();
    this.setStatus({ state: "ready" });
    this.onTitleRefresh();
    return [];
  }

  // Re-issue session/list (snooped by the control plane for the title), then
  // ask the caller to refresh. Best-effort; never throws into the caller.
  private async refreshTitle(): Promise<void> {
    try {
      if (!this.closed && this.ws?.readyState === WebSocket.OPEN) await this.rpc("session/list", {}, 10_000);
    } catch {}
    this.onTitleRefresh();
  }

  private async findExistingSession(): Promise<string | null> {
    this.setStatus({ state: "connecting", detail: "Looking for your conversation..." });
    const res = await this.rpc("session/list", {});
    if (res.error) return null;
    const sessions = (res.result as SessionListResult | undefined)?.sessions ?? [];
    const here = sessions.filter((s) => !s.cwd || s.cwd === CWD);
    here.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
    return here[0]?.sessionId ?? null;
  }

  private async loadSession(sessionId: string): Promise<HistoryMessage[]> {
    this.setStatus({ state: "connecting", detail: "Loading your conversation..." });
    this.sessionId = sessionId;
    this.loadingHistory = true;
    this.replay = [];
    const settled = this.waitForReplayToSettle();
    const res = await this.rpc("session/load", { sessionId, cwd: CWD, mcpServers: [] });
    if (res.error) {
      // The stored session is unusable; fall back to a fresh one.
      this.loadingHistory = false;
      await this.newSession();
      return [];
    }
    await settled;
    this.loadingHistory = false;
    const history = reconstructHistory(this.replay);
    this.replay = [];
    return history;
  }

  private async newSession(): Promise<void> {
    const res = await this.rpc("session/new", { cwd: CWD, mcpServers: [] });
    if (res.error) throw new Error(res.error.message ?? JSON.stringify(res.error));
    const sessionId = (res.result as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) throw new Error("agent did not return a session id");
    this.sessionId = sessionId;
  }

  // session/load streams the transcript back over time with no end marker, so
  // resolve once the replay goes quiet (or a hard cap elapses).
  private waitForReplayToSettle(): Promise<void> {
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(quiet);
        clearTimeout(cap);
        this.bumpReplay = null;
        resolve();
      };
      const cap = setTimeout(finish, 5000);
      this.bumpReplay = () => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, 600);
      };
      this.bumpReplay();
    });
  }

  private rpc(method: string, params: unknown, timeoutMs = 120_000): Promise<RpcMessage> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Socket is not open");
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `${method} timed out` } });
      }, timeoutMs);
      this.pending.set(id, (m) => {
        window.clearTimeout(timer);
        resolve(m);
      });
      this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private route(m: RpcMessage): void {
    if (m.id != null && this.pending.has(m.id)) {
      this.pending.get(m.id)?.(m);
      this.pending.delete(m.id);
      return;
    }
    if (m.method !== "session/update") return;
    const u = m.params?.update;
    const kind = u?.sessionUpdate;

    if (this.loadingHistory) {
      const chunkText = (u?.content as { text?: string } | undefined)?.text ?? "";
      if (kind === "user_message_chunk") this.replay.push({ role: "user", text: chunkText });
      else if (kind === "agent_message_chunk") this.replay.push({ role: "assistant", text: chunkText });
      else return;
      this.bumpReplay?.();
      return;
    }

    if (kind === "agent_message_chunk") {
      const text = (u?.content as { text?: string } | undefined)?.text ?? "";
      if (text) this.activeStream?.push({ kind: "text", delta: text });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const tool = this.upsertTool(u);
      if (tool) this.activeStream?.push({ kind: "tool", tool });
    }
  }

  // Merge a tool_call / tool_call_update note into the running tool state.
  private upsertTool(u?: SessionUpdate): ToolCall | null {
    const id = u?.toolCallId;
    if (!id) return null;
    const prev = this.toolStates.get(id);
    const next: ToolCall = {
      id,
      name: u?.title ?? prev?.name ?? "tool",
      status: u?.status ? mapToolStatus(u.status) : (prev?.status ?? "running"),
      argsText: argsTextOf(u?.rawInput) ?? prev?.argsText,
      resultText: resultTextOf(u) ?? prev?.resultText,
    };
    this.toolStates.set(id, next);
    return next;
  }
}

function mapToolStatus(s: string): ToolCall["status"] {
  if (s === "completed") return "complete";
  if (s === "failed") return "error";
  return "running";
}

// rawInput streams in (it starts as {} and fills); only show it once it has keys.
function argsTextOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object" || Object.keys(rawInput).length === 0) return undefined;
  try {
    return JSON.stringify(rawInput, null, 2);
  } catch {
    return undefined;
  }
}

// The result lives in the note's content array as { content: { text } } items.
function resultTextOf(u?: SessionUpdate): string | undefined {
  if (!Array.isArray(u?.content)) return undefined;
  const texts = u.content.map(contentItemText).filter(Boolean);
  return texts.length ? texts.join("\n") : undefined;
}

function contentItemText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const it = item as { text?: string; content?: { text?: string } };
  if (it.content && typeof it.content === "object") return it.content.text ?? "";
  return typeof it.text === "string" ? it.text : "";
}

// session/load replays the conversation as repeated, growing snapshots, each
// message a full text, every snapshot restarting at the first user message.
// The complete transcript is therefore the longest snapshot.
function reconstructHistory(chunks: HistoryMessage[]): HistoryMessage[] {
  const cleaned = chunks
    .map((c) => ({ role: c.role, text: c.text.replace(/^\n+/, "") }))
    .filter((c) => c.text.length > 0);
  if (cleaned.length === 0) return [];

  const firstUser = cleaned.find((c) => c.role === "user")?.text;
  const snapshots: HistoryMessage[][] = [];
  let current: HistoryMessage[] = [];
  for (const c of cleaned) {
    if (c.role === "user" && c.text === firstUser && current.length > 0) {
      snapshots.push(current);
      current = [];
    }
    const last = current[current.length - 1];
    if (last && last.role === c.role && last.text === c.text) continue; // drop consecutive dupes
    current.push(c);
  }
  if (current.length > 0) snapshots.push(current);

  let best: HistoryMessage[] = [];
  for (const s of snapshots) if (s.length >= best.length) best = s;
  return best;
}

function createStreamQueue(): StreamQueue {
  const values: StreamEvent[] = [];
  let done = false;
  let error: unknown = null;
  let wake: (() => void) | null = null;

  return {
    push(event) {
      if (done) return;
      values.push(event);
      wake?.();
      wake = null;
    },
    close() {
      done = true;
      wake?.();
      wake = null;
    },
    fail(err) {
      error = err;
      done = true;
      wake?.();
      wake = null;
    },
    async *stream() {
      while (!done || values.length > 0) {
        if (values.length > 0) {
          yield values.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
      if (error) throw error;
    },
  };
}

// stdio-to-ws frames are concatenated JSON, not reliably newline-delimited.
function drain(s: string, cb: (m: RpcMessage) => void): string {
  let i = 0;
  while (i < s.length) {
    while (i < s.length && " \n\r\t".includes(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] !== "{") {
      i++;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    let done = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        if (--depth === 0) {
          j++;
          done = true;
          break;
        }
      }
    }
    if (!done) return s.slice(i);
    try {
      cb(JSON.parse(s.slice(i, j)) as RpcMessage);
    } catch {}
    i = j;
  }
  return s.slice(i);
}
