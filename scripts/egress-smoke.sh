#!/usr/bin/env bash
# Proves egress containment against the PRODUCTION topology: each conversation
# gets its OWN --internal network (hakanai-net-<id>); the proxy is joined to
# every such network; an agent on it can reach ONLY allowlisted hosts, and only
# through the proxy. Raw egress and off-list hosts both fail. (ALLOW=example.com
# for the test; v1 would allow only Vertex.)
#
# Mirrors control-plane/orchestrator.ts: ensureInfra() makes the hakanai-egress
# bridge + proxy, spawnAgent() makes a per-conversation --internal net and joins
# the proxy to it. We reproduce that here (without the control plane) so this
# smoke drifts visibly if the deployed topology changes.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# Per-conversation net name follows orchestrator's convNet(id) = hakanai-net-<id>.
ID=smoke$$ NET="hakanai-net-smoke$$" EGR=hakanai-egress PROXY=hakanai-proxy

cleanup() {
  docker rm -f "$PROXY" >/dev/null 2>&1
  # Detach the proxy (a long-lived member) before removing the conversation net,
  # the same ordering reapConversation() uses.
  docker network disconnect -f "$NET" "$PROXY" >/dev/null 2>&1
  docker network rm "$NET" "$EGR" >/dev/null 2>&1
}
trap cleanup EXIT

docker build -q -t hakanai-egress:dev "$here/../egress-proxy" >/dev/null
# Egress bridge (has internet; only the proxy is on it) -- ensureInfra().
docker network create "$EGR" >/dev/null 2>&1 || true
docker run -d --name "$PROXY" --network "$EGR" -e ALLOW=example.com -e PORT=8888 \
  hakanai-egress:dev >/dev/null
# This conversation's own isolated network + join the proxy -- spawnAgent().
docker network create --internal "$NET" >/dev/null 2>&1 || true
docker network connect "$NET" "$PROXY"
sleep 1

OUT=$(docker run --rm --network "$NET" hakanai-agent:dev bun -e '
const P="http://hakanai-proxy:8888";
async function t(l,u,o){const c=new AbortController();const id=setTimeout(()=>c.abort(),6000);try{const r=await fetch(u,{...o,signal:c.signal});console.log(l,"REACHED",r.status)}catch(e){console.log(l,"FAILED",e.name)}finally{clearTimeout(id)}}
await t("allowed-proxied","https://example.com/",{proxy:P});
await t("denied-proxied","https://example.org/",{proxy:P});
await t("raw-direct","https://example.com/",{});
' 2>&1)
echo "$OUT"
echo "--- proxy log ---"; docker logs "$PROXY" 2>&1 | tail -5
echo "---"

# A denied host must never return the TARGET's response. The proxy refuses the
# CONNECT with 403, which Bun surfaces as a 403 response (not a throw) -- so the
# breach signal is specifically "denied-proxied REACHED 200" (target answered).
pass=1
grep -q "allowed-proxied REACHED 200" <<<"$OUT" || { echo "FAIL: allowlisted host not reachable via proxy"; pass=0; }
grep -q "denied-proxied REACHED 200"  <<<"$OUT" && { echo "FAIL: off-list host actually answered (breach)"; pass=0; }
grep -qE "denied-proxied (REACHED 403|FAILED)" <<<"$OUT" || { echo "FAIL: off-list host not clearly blocked"; pass=0; }
grep -q "raw-direct FAILED"          <<<"$OUT" || { echo "FAIL: raw egress not blocked"; pass=0; }
[ "$pass" = 1 ] && echo "EGRESS SMOKE OK" || exit 1
