#!/usr/bin/env bash
# Proves the deletion clock is durable: a control plane restart must NOT reset a
# conversation's last-activity (which would silently extend the 3-day idle
# window). Recreates the control-plane container so its in-memory state is wiped
# and only the persisted index on the state volume remains.
#
# Run with the stack up (./hakanai up). Creates a throwaway conversation, reaps
# it at the end.
set -uo pipefail
BASE=${BASE:-http://127.0.0.1:8800}
# The browser-origin guard requires a matching Origin on state-changing requests
# (see ADR-0004); these scripts stand in for the UI, so they send it as the
# browser would. BASE is exactly that origin.
ORIGIN=${ORIGIN:-$BASE}

cp=$(docker ps --format '{{.Names}}' | grep -m1 control-plane)
[ -n "$cp" ] || { echo "FAIL: control-plane container not found (is the stack up?)"; exit 1; }

# last-activity for a given conversation id, read from the conversations list.
last_of() { curl -s "$BASE/api/conversations" | bun -e '
  const id = process.argv[1];
  const list = JSON.parse(await Bun.stdin.text());
  const c = list.find((x) => x.id === id);
  process.stdout.write(c ? String(c.lastActivity) : "");
' "$1"; }

id=$(curl -s -X POST -H "Origin: $ORIGIN" "$BASE/api/conversations" | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ -n "$id" ] || { echo "FAIL: create returned no id"; exit 1; }
echo "created $id"
cleanup() { curl -s -X DELETE -H "Origin: $ORIGIN" "$BASE/api/conversations/$id" >/dev/null 2>&1; }
trap cleanup EXIT

created=$(last_of "$id")
sleep 3
# Opening a conversation resets the clock; activate touches it.
curl -s -X POST -H "Origin: $ORIGIN" "$BASE/api/conversations/$id/activate" >/dev/null
before=$(last_of "$id")
echo "created=$created before-restart=$before (delta $((before - created))ms)"
[ "$((before - created))" -ge 2000 ] || { echo "FAIL: activate did not advance last-activity"; exit 1; }

# The index must be on the mounted state volume, not just in memory.
docker exec "$cp" cat /state/activity.json 2>/dev/null | grep -q "\"$id\"" \
  || { echo "FAIL: conversation not found in persisted /state/activity.json"; exit 1; }

echo "recreating control plane..."
docker compose up -d --force-recreate --no-deps control-plane >/dev/null 2>&1
for _ in $(seq 1 60); do curl -sf "$BASE/api/config" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$BASE/api/config" >/dev/null 2>&1 || { echo "FAIL: control plane did not come back"; exit 1; }

after=$(last_of "$id")
[ -n "$after" ] || { echo "FAIL: conversation gone after restart"; exit 1; }
echo "after-restart=$after (drift from before $((after - before))ms)"

# The persisted value must survive: equal to the pre-restart value (small slack),
# and clearly not reset to creation time (which is >=2s earlier) or to now.
drift=$((after - before)); drift=${drift#-}
[ "$drift" -le 1500 ] || { echo "FAIL: clock reset on restart (drift ${drift}ms)"; exit 1; }

echo "CLOCK SMOKE OK"
