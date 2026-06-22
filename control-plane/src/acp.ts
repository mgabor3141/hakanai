import type { ConnectionState } from "./types";

export type AcpStatus = { state: ConnectionState; detail?: string };

type RpcMessage = {
  id?: number;
  method?: string;
  params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

type StreamQueue = {
  push(text: string): void;
  close(): void;
  fail(error: unknown): void;
  stream(): AsyncGenerator<string>;
};

export class AcpConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, (m: RpcMessage) => void>();
  private buffer = "";
  private sessionId: string | null = null;
  private connecting: Promise<void> | null = null;
  private activeStream: StreamQueue | null = null;
  private closed = false;

  constructor(
    private readonly conversationId: string,
    private readonly setStatus: (status: AcpStatus) => void,
  ) {}

  async promptStream(text: string): Promise<AsyncGenerator<string>> {
    await this.connect();
    if (!this.sessionId) throw new Error("No active ACP session");

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

  connect(): Promise<void> {
    if (this.sessionId) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = this.openAndInitialize();
    return this.connecting;
  }

  private async openAndInitialize(): Promise<void> {
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

    this.setStatus({ state: "connecting", detail: "Opening a private session..." });
    const sn = await this.rpc("session/new", { cwd: "/work", mcpServers: [] });
    if (sn.error) throw new Error(sn.error.message ?? JSON.stringify(sn.error));
    const sessionId = (sn.result as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) throw new Error("agent did not return a session id");
    this.sessionId = sessionId;
    this.setStatus({ state: "ready" });
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
      if (u?.sessionUpdate === "agent_message_chunk") this.activeStream?.push(u.content?.text ?? "");
    }
  }
}

function createStreamQueue(): StreamQueue {
  const values: string[] = [];
  let done = false;
  let error: unknown = null;
  let wake: (() => void) | null = null;

  return {
    push(text) {
      if (!text || done) return;
      values.push(text);
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
