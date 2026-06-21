// Stub agent for the tracer bullet. Speaks a trivial JSON-over-ws protocol and
// echoes, while writing a transcript into /work to prove conversation data lands
// only in the disposable volume.
//
// SEAM(agent): replace this with `pi-acp` wrapped by `@rebornix/stdio-to-ws`.
// The control plane's ws proxy is byte-transparent, so swapping the agent does
// not touch the orchestration -- the browser UI moves to ACP/AG-UI rendering.
import { appendFileSync } from "node:fs";

const PORT = 7000;
const TRANSCRIPT = "/work/transcript.log";

Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("hako-ephemeral agent (websocket only)\n");
  },
  websocket: {
    message(ws, raw) {
      let text = String(raw);
      try {
        text = JSON.parse(text).text ?? text;
      } catch {}
      appendFileSync(TRANSCRIPT, `user: ${text}\n`);
      const reply = `echo: ${text}`;
      appendFileSync(TRANSCRIPT, `agent: ${reply}\n`);
      ws.send(JSON.stringify({ role: "agent", text: reply }));
    },
  },
});

console.log(`hako-ephemeral stub agent listening on :${PORT}`);
