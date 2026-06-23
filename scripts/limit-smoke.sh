#!/usr/bin/env bash
# Proves the single-machine memory budget against a running stack:
#   - at most HAKANAI_MAX_ACTIVE agent containers run at once (idle ones are
#     stopped, not deleted, to make room);
#   - each agent runs with memory, pids, and cpu limits.
#
# Run with the stack up (./hakanai up). Creates throwaway conversations and
# reaps them. Assumes the default cap of 2.
set -uo pipefail
BASE=${BASE:-http://127.0.0.1:8800}
CAP=${HAKANAI_MAX_ACTIVE:-2}
# The browser-origin guard requires a matching Origin on state-changing requests
# (see ADR-0004); this script stands in for the UI, so it sends it.
ORIGIN=${ORIGIN:-$BASE}

create() { curl -s -X POST -H "Origin: $ORIGIN" "$BASE/api/conversations" | sed -E 's/.*"id":"([^"]+)".*/\1/'; }
running_count() { docker ps --filter label=hakanai=1 --format '{{.Names}}' | grep -c . ; }

ids=()
for i in $(seq 1 $((CAP + 1))); do
  id=$(create)
  [ -n "$id" ] || { echo "FAIL: create returned no id (is the stack up?)"; exit 1; }
  ids+=("$id")
  echo "created $id"
done

cleanup() { for id in "${ids[@]}"; do curl -s -X DELETE -H "Origin: $ORIGIN" "$BASE/api/conversations/$id" >/dev/null 2>&1; done; }
trap cleanup EXIT

run=$(running_count)
echo "running agents: $run (cap $CAP)"
total=$(docker ps -a --filter label=hakanai=1 --format '{{.Names}}' | grep -c .)
echo "total agents (running + stopped): $total"

pass=1
[ "$run" -le "$CAP" ] || { echo "FAIL: $run running exceeds cap $CAP"; pass=0; }
[ "$run" -eq "$CAP" ] || { echo "FAIL: expected exactly $CAP running, got $run"; pass=0; }
[ "$total" -gt "$run" ] || { echo "FAIL: evicted conversation was deleted, not stopped"; pass=0; }

# Limits on a created agent.
n="hakanai-${ids[0]}"
mem=$(docker inspect -f '{{.HostConfig.Memory}}' "$n" 2>/dev/null || echo 0)
pids=$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$n" 2>/dev/null); [ "$pids" = "<nil>" ] && pids=0
cpus=$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$n" 2>/dev/null || echo 0)
echo "limits on $n: memory=$mem pids=$pids cpus(nano)=$cpus"
[ "${mem:-0}" -gt 0 ] || { echo "FAIL: no memory limit"; pass=0; }
[ "${pids:-0}" -gt 0 ] || { echo "FAIL: no pids limit"; pass=0; }
[ "${cpus:-0}" -gt 0 ] || { echo "FAIL: no cpu limit"; pass=0; }

[ "$pass" = 1 ] && echo "LIMIT SMOKE OK" || exit 1
