#!/usr/bin/env bash
# Wrapper for settings-smoke.ts: source the real OpenAI-compatible creds (if the
# operator stashed them at .memory/oai-creds.env -- untracked) so the smoke can
# exercise the OpenAI provider path end-to-end, then run the smoke. The creds-
# free subset (409 not_configured + the SSRF guard) runs either way.
#
# Run with the stack up (`./hakanai up`), then: bash scripts/settings-smoke.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
creds="$here/../.memory/oai-creds.env"

if [ -f "$creds" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$creds"
  set +a
fi

exec bun "$here/settings-smoke.ts"
