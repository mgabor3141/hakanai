#!/usr/bin/env bash
# Proves cross-conversation isolation against a running stack: one conversation's
# agent must NOT be able to reach the control-plane API, nor another
# conversation's agent. Both are cross-conversation PII leaks inside the box.
#
# Run with the stack up (./hakanai up). Creates two throwaway conversations,
# probes from inside one agent, and reaps them.
set -uo pipefail
BASE=${BASE:-http://127.0.0.1:8800}

create() { curl -s -X POST "$BASE/api/conversations" | sed -E 's/.*"id":"([^"]+)".*/\1/'; }
ips_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1" 2>/dev/null; }

id1=$(create); id2=$(create)
[ -n "$id1" ] && [ -n "$id2" ] || { echo "FAIL: could not create two conversations (is the stack up?)"; exit 1; }
A="hakanai-$id1"; B="hakanai-$id2"

cleanup() {
  curl -s -X DELETE "$BASE/api/conversations/$id1" >/dev/null 2>&1
  curl -s -X DELETE "$BASE/api/conversations/$id2" >/dev/null 2>&1
}
trap cleanup EXIT

cp=$(docker ps --format '{{.Names}}' | grep -i control-plane | head -1)

# From inside agent A, try to open a raw TCP socket (ignores HTTP_PROXY, the way
# a hostile agent would). REACHED on any target is a breach.
probe() { # ip port
  docker exec "$A" python3 -c "
import socket
s=socket.socket(); s.settimeout(4)
try:
    s.connect(('$1', int('$2'))); print('REACHED')
except Exception:
    print('blocked')
" 2>/dev/null
}

breach=0
for ip in $(ips_of "$cp"); do
  [ -n "$ip" ] || continue
  r=$(probe "$ip" 8800); echo "agent A -> control-plane $ip:8800  => $r"
  [ "$r" = "REACHED" ] && breach=1
done
for ip in $(ips_of "$B"); do
  [ -n "$ip" ] || continue
  r=$(probe "$ip" 7000); echo "agent A -> agent B    $ip:7000  => $r"
  [ "$r" = "REACHED" ] && breach=1
done

[ "$breach" = 1 ] && { echo "ISOLATION SMOKE FAIL: cross-conversation reachability"; exit 1; }
echo "ISOLATION SMOKE OK"
