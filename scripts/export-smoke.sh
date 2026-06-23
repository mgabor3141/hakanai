#!/usr/bin/env bash
# Proves the file-export path cannot be used to read outside the agent's /work
# volume. The agent is hostile (prompt-injectable), so a symlink at
# /work/x -> a secret would exfiltrate it unless the export resolves symlinks
# and rejects targets that escape /work (see exportFile in orchestrator.ts).
#
# Run with the stack up (./hakanai up). Creates a throwaway conversation, plants
# a normal file and two escape symlinks in /work, exports each via the API, and
# reaps the conversation.
set -uo pipefail
BASE=${BASE:-http://127.0.0.1:8800}

id=$(curl -s -X POST "$BASE/api/conversations" | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ -n "$id" ] || { echo "FAIL: create returned no id (is the stack up?)"; exit 1; }
echo "created $id"
n="hakanai-$id"
cleanup() { curl -s -X DELETE "$BASE/api/conversations/$id" >/dev/null 2>&1; }
trap cleanup EXIT

# A legitimate file the agent produced, plus two symlinks escaping /work the way
# a hostile agent would plant them.
docker exec "$n" sh -c '
  printf hello > /work/real.txt
  ln -sf /etc/passwd /work/escape-passwd
  ln -sf /root/.pi/agent/auth.json /work/escape-secret
' || { echo "FAIL: could not stage files in container"; exit 1; }

# HTTP status of an export request for a given in-container path.
status() { curl -s -o /dev/null -w '%{http_code}' "$BASE/api/conversations/$id/files?path=$1"; }
# Body of an export request.
body() { curl -s "$BASE/api/conversations/$id/files?path=$1"; }

fail=0

ok=$(status "/work/real.txt")
got=$(body "/work/real.txt")
echo "export /work/real.txt        => $ok ($got)"
{ [ "$ok" = 200 ] && [ "$got" = hello ]; } || { echo "  FAIL: normal /work file must export"; fail=1; }

for link in escape-passwd escape-secret; do
  code=$(status "/work/$link")
  echo "export /work/$link  => $code"
  # Must NOT be a successful download. 404 (resolved target rejected) is expected.
  [ "$code" = 200 ] && { echo "  FAIL: symlink escape exported data outside /work"; fail=1; }
done

[ "$fail" = 0 ] || { echo "EXPORT SMOKE FAIL"; exit 1; }
echo "EXPORT SMOKE OK"
