// Minimal ACP agent for model-free testing. Speaks the same protocol shape as
// pi-acp (JSON-RPC over stdio, wrapped to ws by stdio-to-ws), so the browser
// client and smokes exercise the REAL ACP flow -- initialize, session/new,
// session/prompt with streamed session/update -- without needing a model.
// Echoes the prompt back as a streamed agent message, and writes a transcript
// into /work to demonstrate data containment in the disposable volume.
import { appendFileSync } from "node:fs";

const TRANSCRIPT = "/work/transcript.log";
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

let buf = "";
process.stdin.on("data", (d: Buffer) => {
  buf += d.toString("utf8");
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

function handle(line: string) {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  switch (m.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "hakanai-stub", version: "0" },
          authMethods: [],
          agentCapabilities: { promptCapabilities: { image: false } },
        },
      });
    case "session/new":
      return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "stub-session" } });
    case "session/prompt": {
      const text = (m.params?.prompt ?? []).map((b: any) => b.text ?? "").join("");
      appendFileSync(TRANSCRIPT, `user: ${text}\n`);
      const reply = `echo: ${text}`;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: m.params?.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
        },
      });
      appendFileSync(TRANSCRIPT, `agent: ${reply}\n`);
      return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
    }
    default:
      if (m.id != null) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
}
