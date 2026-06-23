#!/usr/bin/env bash
# Proves the browser-origin guard against a running stack: the control plane
# must reject requests that a hostile page in the user's own browser would make
# (CSRF and DNS rebinding) while accepting the legitimate same-origin UI. The
# API has no accounts, so this header check is the whole defense (see ADR-0004).
#
# Run with the stack up (./hakanai up). Makes no lasting changes on the happy
# path (it reaps the one conversation it creates); the attack probes are all
# rejected, so they create nothing.
set -uo pipefail
BASE=${BASE:-http://127.0.0.1:8800}
GOOD_ORIGIN=${GOOD_ORIGIN:-http://127.0.0.1:8800}

fail=0
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== rejections (a hostile page must not be able to act) =="

# CSRF: a foreign Origin on a state-changing spawn. Must be 403, not 200.
c=$(code -X POST -H "Origin: https://evil.example" "$BASE/api/conversations")
echo "POST /api/conversations  Origin=evil          => $c"
[ "$c" = "403" ] || { echo "  FAIL: cross-site spawn was not rejected"; fail=1; }

# CSRF: a state-changing request with no Origin at all (fail closed).
c=$(code -X POST "$BASE/api/conversations")
echo "POST /api/conversations  (no Origin)          => $c"
[ "$c" = "403" ] || { echo "  FAIL: origin-less spawn was not rejected"; fail=1; }

# CSRF: cross-site delete of an (arbitrary) conversation.
c=$(code -X DELETE -H "Origin: https://evil.example" "$BASE/api/conversations/whatever")
echo "DELETE /api/conversations/x  Origin=evil       => $c"
[ "$c" = "403" ] || { echo "  FAIL: cross-site delete was not rejected"; fail=1; }

# DNS rebinding: legitimate-looking method, but a forged Host header (the page
# rebound its own name to 127.0.0.1). Even a GET that returns PII must be 403.
c=$(code -H "Host: evil.example:8800" "$BASE/api/conversations")
echo "GET  /api/conversations  Host=evil            => $c"
[ "$c" = "403" ] || { echo "  FAIL: rebound Host was not rejected"; fail=1; }

c=$(code -H "Host: evil.example:8800" "$BASE/api/conversations/x/files?path=/work/secret")
echo "GET  /files  Host=evil                        => $c"
[ "$c" = "403" ] || { echo "  FAIL: rebound Host read of /files was not rejected"; fail=1; }

echo
echo "== acceptance (the real UI must keep working) =="

# A same-origin GET read (browsers send no Origin; the Host is ours).
c=$(code "$BASE/api/conversations")
echo "GET  /api/conversations  (same origin)        => $c"
[ "$c" = "200" ] || { echo "  FAIL: legitimate read was rejected"; fail=1; }

# A same-origin state-changing spawn carries the page's matching Origin.
id=$(curl -s -X POST -H "Origin: $GOOD_ORIGIN" "$BASE/api/conversations" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "POST /api/conversations  Origin=$GOOD_ORIGIN  => id=${id:-<none>}"
if [ -n "$id" ]; then
  curl -s -X DELETE -H "Origin: $GOOD_ORIGIN" "$BASE/api/conversations/$id" >/dev/null
else
  echo "  FAIL: legitimate same-origin spawn was rejected"; fail=1
fi

echo
[ "$fail" = 1 ] && { echo "ORIGIN SMOKE FAIL"; exit 1; }
echo "ORIGIN SMOKE OK"
