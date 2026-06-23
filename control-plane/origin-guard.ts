// Browser-origin protection for the single-user localhost control plane.
// See docs/adr/0004-browser-origin-guard.md. The API has no accounts on purpose
// (one user, one machine), so the threat is the user's *own* browser being
// pointed at us by a hostile page they happen to be visiting. Two fail-closed
// header checks, derived purely from the listener's public origin, close that:
//
//   Host   — must name this very listener (127.0.0.1:PORT / localhost:PORT).
//            A DNS-rebinding page that re-points its own hostname at 127.0.0.1
//            still sends `Host: evil.example:PORT`, so we reject it even though
//            the TCP connection landed locally. Checked on *every* request,
//            including GET reads that return PII (/files) and the ws upgrade,
//            because rebinding turns those into "same-origin" from the browser's
//            view and the Host header is the only thing that still betrays it.
//
//   Origin — when it must be present, must be one of our origins. Browsers
//            attach Origin to cross-site state-changing requests and to every
//            websocket handshake, so a hostile page cannot forge it. Required
//            (present AND matching) on state-changing methods and on the ws
//            upgrade. Plain cross-site GET reads need no Origin check: the
//            same-origin policy already stops the attacker reading the response,
//            and rebinding (where they could) is caught by the Host check above.

export type GuardInput = {
  method: string;
  host: string | null;
  origin: string | null;
  // The ws handshake is a GET, but unlike fetch it is exempt from the
  // same-origin policy, so a hostile page can open it cross-site. Force the
  // Origin check for it regardless of method.
  isWebSocket?: boolean;
};

// The host:port strings the browser may legitimately have dialed to reach us.
export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

// The full origins (scheme + host:port) those hosts correspond to. The control
// plane is served over plain http on loopback, so http:// is the only scheme.
export function allowedOrigins(port: number): Set<string> {
  const o = new Set<string>();
  for (const h of allowedHosts(port)) o.add(`http://${h}`);
  return o;
}

// Returns null when the request is allowed, or a short reason string when it
// must be rejected (the caller answers 403). Pure, so it is fully unit-tested.
export function checkBrowserOrigin(req: GuardInput, port: number): string | null {
  // 1. Host must name this listener — defeats DNS rebinding on any method.
  if (!req.host || !allowedHosts(port).has(req.host)) {
    return `bad host: ${req.host ?? "(none)"}`;
  }
  // 2. State-changing requests and the ws upgrade must carry a matching Origin
  //    — defeats cross-site (CSRF) writes and hostile ws connections.
  const mustHaveOrigin = req.isWebSocket || (req.method !== "GET" && req.method !== "HEAD");
  if (mustHaveOrigin && (!req.origin || !allowedOrigins(port).has(req.origin))) {
    return `bad origin: ${req.origin ?? "(none)"}`;
  }
  return null;
}
