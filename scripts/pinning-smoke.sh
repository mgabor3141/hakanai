#!/usr/bin/env bash
# Proves the supply-chain pinning invariant by inspection (no build, no creds):
# every Dockerfile base image is pinned by @sha256 digest, the agent's npm
# globals and pip packages are pinned to exact versions, and renovate.json --
# which bumps those pins -- is valid JSON. A regression here silently reopens
# the "builds are not reproducible / auditable" gap, so it must fail loudly.
#
# apk packages are deliberately NOT checked: Alpine repos serve only the current
# version of each package, so version pins break on the next repo roll; the
# base-image digest covers that layer instead (see SECURITY.md).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/.."
pass=1

for df in control-plane agent egress-proxy; do
  file="$root/$df/Dockerfile"
  from=$(grep -E '^FROM ' "$file")
  if grep -qE '^FROM .+@sha256:[0-9a-f]{64}' "$file"; then
    echo "OK:   $df base image digest-pinned"
  else
    echo "FAIL: $df base image not @sha256-pinned -> $from"; pass=0
  fi
done

# Every package spec on the `npm i -g` line must carry an explicit @version.
npm_line=$(grep -E 'npm i -g' "$root/agent/Dockerfile")
for tok in $npm_line; do
  case "$tok" in
    npm|i|-g|'&&'|'\') continue ;;
  esac
  if [[ "$tok" =~ .+@[0-9] ]]; then
    echo "OK:   npm $tok pinned"
  else
    echo "FAIL: npm global not version-pinned -> $tok"; pass=0
  fi
done

# Every package on the `pip install` line must carry an explicit ==version.
pip_line=$(grep -E 'python-docx' "$root/agent/Dockerfile")
for tok in $pip_line; do
  case "$tok" in
    python-docx*|python-pptx*|openpyxl*|pypdf*) ;;
    *) continue ;;
  esac
  if [[ "$tok" =~ ==[0-9] ]]; then
    echo "OK:   pip $tok pinned"
  else
    echo "FAIL: pip package not version-pinned -> $tok"; pass=0
  fi
done

if command -v bun >/dev/null 2>&1; then
  if bun -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$root/renovate.json" 2>/dev/null; then
    echo "OK:   renovate.json is valid JSON"
  else
    echo "FAIL: renovate.json is not valid JSON"; pass=0
  fi
fi

[ "$pass" = 1 ] && echo "PINNING SMOKE OK" || exit 1
