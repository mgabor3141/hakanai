#!/usr/bin/env bash
# Proves egress containment: an agent on the internal network can reach ONLY
# allowlisted hosts, and only through the proxy. Raw egress and off-list hosts
# both fail. (ALLOW=example.com for the test; v1 would allow only Vertex.)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
INT=hakanai-internal EGR=hakanai-egress PROXY=hakanai-proxy

cleanup() {
  docker rm -f "$PROXY" >/dev/null 2>&1
  docker network rm "$INT" "$EGR" >/dev/null 2>&1
}
trap cleanup EXIT

docker build -q -t hakanai-egress:dev "$here/../egress-proxy" >/dev/null
docker network create --internal "$INT" >/dev/null 2>&1 || true
docker network create "$EGR" >/dev/null 2>&1 || true
# ALLOW carries an explicit port (host:port form) to prove the proxy parses it
# and that a host-with-port config reaches end to end. 443 is example.com's TLS
# port, so allowed-proxied must still succeed; off-port (:8443) must be denied.
docker run -d --name "$PROXY" --network "$EGR" -e ALLOW=example.com:443 -e PORT=8888 \
  hakanai-egress:dev >/dev/null
docker network connect "$INT" "$PROXY"
sleep 1

OUT=$(docker run --rm --network "$INT" hakanai-agent:dev bun -e '
const P="http://hakanai-proxy:8888";
async function t(l,u,o){const c=new AbortController();const id=setTimeout(()=>c.abort(),6000);try{const r=await fetch(u,{...o,signal:c.signal});console.log(l,"REACHED",r.status)}catch(e){console.log(l,"FAILED",e.name)}finally{clearTimeout(id)}}
await t("allowed-proxied","https://example.com/",{proxy:P});
await t("offport-proxied","https://example.com:8443/",{proxy:P});
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
grep -q "allowed-proxied REACHED 200" <<<"$OUT" || { echo "FAIL: allowlisted host:port not reachable via proxy"; pass=0; }
# The allowlisted host on a NON-allowlisted port must be refused, never answered.
grep -q "offport-proxied REACHED 200" <<<"$OUT" && { echo "FAIL: allowlisted host reachable on off-list port (breach)"; pass=0; }
grep -qE "offport-proxied (REACHED 403|FAILED)" <<<"$OUT" || { echo "FAIL: off-port not clearly blocked"; pass=0; }
grep -q "denied-proxied REACHED 200"  <<<"$OUT" && { echo "FAIL: off-list host actually answered (breach)"; pass=0; }
grep -qE "denied-proxied (REACHED 403|FAILED)" <<<"$OUT" || { echo "FAIL: off-list host not clearly blocked"; pass=0; }
grep -q "raw-direct FAILED"          <<<"$OUT" || { echo "FAIL: raw egress not blocked"; pass=0; }
[ "$pass" = 1 ] && echo "EGRESS SMOKE OK" || exit 1
