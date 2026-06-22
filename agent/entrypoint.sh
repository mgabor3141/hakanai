#!/bin/sh
# Write pi's defaults so the env-configured OpenAI-compatible provider (registered
# by the hakanai-inference extension) is selected without interactive choice,
# then launch pi-acp wrapped to a websocket.
set -e
mkdir -p "$HOME/.pi/agent"
cat > "$HOME/.pi/agent/settings.json" <<EOF
{
  "defaultProvider": "hakanai",
  "defaultModel": "${HAKANAI_MODEL:-best}",
  "defaultProjectTrust": "always",
  "quietStartup": true
}
EOF
exec stdio-to-ws --port 7000 --persist pi-acp
