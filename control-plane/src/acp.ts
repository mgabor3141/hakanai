import type { ConnectionState } from "./types";

export type AcpEvent =
  | { type: "state"; state: ConnectionState; detail?: string }
  | { type: "assistant-delta"; text: string }
  | { type: "system"; text: string };

type RpcMessage = {
  id?: number;
  method?: string;
  params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

export class AcpConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, (m: RpcMessage) => void>();
  private buffer = "";
  private sessionId: string | null = null;
  private closed = false;

  constructor(
    private readonly conversationId: string,
    private readonly onEvent: (event: AcpEvent) => void,
  ) {}

  async connect(): Promise<void> {
    this.onEvent({ type: "state", state: "connecting", detail: "Starting secure workspace..." });
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/api/conversations/${this.conversationId}/ws`);
    this.ws = ws;

    ws.addEventListener("message", (ev) => {
      this.buffer = drain(this.buffer + String(ev.data), (m) => this.route(m));
    });
    ws.addEventListener("close", () => {
      if (!this.closed) this.onEvent({ type: "state", state: "error", detail: "Connection closed" });
    });
    ws.addEventListener("error", () => this.onEvent({ type: "state", state: "error", detail: "Connection failed" }));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
    });

    this.onEvent({ type: "state", state: "connecting", detail: "Introducing the browser to the agent..." });
    await this.rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });

    this.onEvent({ type: "state", state: "connecting", detail: "Opening a private session..." });
    const sn = await this.rpc("session/new", { cwd: "/work", mcpServers: [] });
    if (sn.error) throw new Error(sn.error.message ?? JSON.stringify(sn.error));
    const sessionId = (sn.result as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) throw new Error("agent did not return a session id");
    this.sessionId = sessionId;
    this.onEvent({ type: "state", state: "ready" });
  }

  async prompt(text: string): Promise<void> {
    if (!this.sessionId) throw new Error("No active session");
    this.onEvent({ type: "state", state: "thinking" });
    const res = await this.rpc("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    if (res.error) throw new Error(res.error.message ?? JSON.stringify(res.error));
    this.onEvent({ type: "state", state: "ready" });
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.pending.values()) resolve({ error: { message: "closed" } });
    this.pending.clear();
    this.ws?.close();
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
    if (m.method === "session/update") {
      const u = m.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk") {
        this.onEvent({ type: "assistant-delta", text: u.content?.text ?? "" });
      }
    }
  }
}

// stdio-to-ws frames are concatenated JSON, not reliably newline-delimited (its
// initial "connected" envelope has no trailing newline), so extract complete
// objects by brace depth and return the unconsumed tail.
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
    } catch {
      // Ignore non-JSON envelopes/noise.
    }
    i = j;
  }
  return s.slice(i);
}

export const newMessageId = () => crypto.randomUUID();
