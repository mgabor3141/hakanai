# ADR-0004: A browser-origin guard for the control-plane API

- **Status:** Accepted — 2026-06-23

## Context

hakanai is single-user: one person, one machine, one instance. The control plane
therefore has **no accounts and no API authentication** — and that is a
deliberate part of the "open localhost, no install" experience. The only network
boundary is the bind to the loopback interface (the published port is
`127.0.0.1:8800`) plus the per-conversation network design (ADR-0001), which
together wall off the LAN and the sandboxed agents.

That boundary does not cover one attacker: **the user's own browser, visiting a
hostile page.** With no Origin/Host validation, the previous code only checked
that a conversation existed. Two attacks followed directly:

- **CSRF.** Any site the user has open can issue cross-origin requests to
  `http://127.0.0.1:8800`: `POST /api/conversations` (spawn — and, repeated,
  unbounded volumes/networks → disk DoS), `DELETE /api/conversations/{id}`
  (destroy the user's data), or an upload. Form-style POSTs are "simple"
  requests, so the browser sends them even though it would block reading the
  response.
- **DNS rebinding.** A malicious page served from `evil.example` can re-point
  that hostname to `127.0.0.1` after first load. The browser then treats
  `http://evil.example:8800` as same-origin with our service, so the page can
  open the websocket, speak ACP to an agent, and read transcripts and `/work`
  files — defeating the loopback bind entirely.

## Decision

Check two request headers at the door, before any routing, in
`control-plane/origin-guard.ts` (pure logic, called from `server.ts`). Both are
derived solely from the listener's public origin and both fail closed:

- **Host must name this listener** — one of `127.0.0.1:8800`, `localhost:8800`,
  `[::1]:8800`. Checked on **every** request, including GET reads that return PII
  (`/files`) and the websocket upgrade. This is what defeats rebinding: the
  rebound page still sends `Host: evil.example:8800`, so even though the TCP
  connection lands on loopback, the request is rejected. A missing Host is
  rejected too.
- **Origin must match** — one of the `http://<allowed-host>` origins — on
  **state-changing methods and the websocket upgrade**. Browsers attach `Origin`
  to cross-site writes and to *every* ws handshake, so a hostile page cannot
  forge it; a missing Origin on a write is also rejected (fail closed).

Plain cross-site **GET reads are intentionally not Origin-checked.** The
same-origin policy already prevents the attacker from reading a cross-origin
GET response, and the one case where they *could* read it — rebinding, which
makes the request same-origin from the browser's view — is already caught by the
Host check. The websocket is the exception among GETs: it is exempt from the
same-origin policy and can be opened cross-site, so it is forced through the
Origin check.

### No bearer token

The task asked whether a per-instance bearer token (held by the UI, injected at
page load) adds meaningful defense-in-depth. **Decision: no token.** For a
single-user loopback service the Host+Origin check already fully closes both CSRF
and rebinding, which are the actual threats. A token would have to be injected
into the page and stored somewhere the JS can read it (so it is reachable by the
same rebinding/XSS that we are defending against), it adds a moving part to the
"open localhost, no install" UX, and it guards no request that the origin check
leaves open. It buys complexity, not security, here. If the product ever grows a
non-loopback or multi-user mode, revisit this — that is a different threat model.

### Alternatives considered

- **A CORS policy alone.** CORS governs whether JS may *read* a cross-origin
  response, not whether the request is *sent*; "simple" CSRF writes go through
  regardless. CORS is not an access-control mechanism for state change, so it
  does not close the hole on its own.
- **Origin check only (no Host check).** Misses rebinding, where the forged
  origin becomes same-origin and the page can read ws transcripts. The Host
  check is the part that specifically defeats rebinding.
- **Host check only (no Origin check).** Misses classic CSRF, where the browser
  dials `127.0.0.1` directly and the Host is genuinely ours; only the foreign
  Origin betrays the cross-site write.
- **Bind harder / firewall.** Already done (loopback bind, per-conversation
  nets); none of it sees inside the user's browser, which is the gap here.

## Consequences

- A hostile page in the user's browser can no longer spawn, delete, upload, or
  read conversation data, and rebinding can no longer reach the websocket. The
  no-auth, no-install UX is unchanged: the real UI is same-origin, so it sails
  through both checks.
- One assumption is baked in: the browser reaches us at `127.0.0.1:8800` /
  `localhost:8800`. The allowed set is derived from `PORT`; a deployment that
  republishes on a different *public* port would need that set widened. This
  matches the appliance's fixed loopback deployment.
- The decision logic is unit-tested (`control-plane/origin-guard.test.ts`) and
  the end-to-end behavior is proven by `scripts/origin-smoke.sh`, wired into
  `./hakanai smoke`.
