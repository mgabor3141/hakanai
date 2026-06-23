#!/bin/sh
# Configure pi for the GLOBAL provider chosen in the Settings UI, then launch
# pi-acp wrapped to a websocket. The agent image is provider-AGNOSTIC: the
# control plane injects the provider config at spawn time via env, and this
# script materializes the matching pi settings.json + models.json before pi
# starts. Two modes (see control-plane/orchestrator.ts and the settings-ui
# handoff), selected by HAKANAI_PROVIDER:
#
#   vertex  -- pi's built-in google-vertex provider, but each model's baseUrl
#              points at the inference sidecar and the only credential here is a
#              PLACEHOLDER (GOOGLE_CLOUD_API_KEY). The real Google credential
#              lives in the sidecar; the agent has NO internet.
#   openai  -- an openai-completions custom provider pointed at the user's
#              endpoint. The (narrow, scoped) token DOES live here, contained by
#              the egress allowlist to that one host; the agent reaches it
#              directly through the egress proxy (HTTP(S)_PROXY). No sidecar.
set -e
mkdir -p "$HOME/.pi/agent"

PROVIDER="${HAKANAI_PROVIDER:-vertex}"
MODEL="${HAKANAI_MODEL:-gemini-2.5-pro}"

if [ "$PROVIDER" = "openai" ]; then
  # The endpoint + model are injected; the apiKey is read from env at request
  # time (pi resolves "$VAR"), so the token is never written to disk here.
  cat > "$HOME/.pi/agent/models.json" <<EOF
{
  "providers": {
    "hakanai-openai": {
      "baseUrl": "${HAKANAI_OPENAI_BASE_URL}",
      "api": "openai-completions",
      "apiKey": "\$HAKANAI_OPENAI_API_KEY",
      "models": [
        { "id": "${MODEL}", "input": ["text", "image"] }
      ]
    }
  }
}
EOF
  cat > "$HOME/.pi/agent/settings.json" <<EOF
{
  "defaultProvider": "hakanai-openai",
  "defaultModel": "${MODEL}",
  "defaultProjectTrust": "always",
  "quietStartup": true
}
EOF
else
  # Vertex: point the selected model's baseUrl at the inference sidecar. The
  # placeholder GOOGLE_CLOUD_API_KEY is set by the orchestrator; the sidecar
  # swaps in the real access token.
  cat > "$HOME/.pi/agent/models.json" <<EOF
{
  "providers": {
    "google-vertex": {
      "models": [
        {
          "id": "${MODEL}",
          "baseUrl": "http://hakanai-inference:8900/v1",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1048576,
          "maxTokens": 65535
        }
      ]
    }
  }
}
EOF
  cat > "$HOME/.pi/agent/settings.json" <<EOF
{
  "defaultProvider": "google-vertex",
  "defaultModel": "${MODEL}",
  "defaultProjectTrust": "always",
  "quietStartup": true
}
EOF
fi

exec stdio-to-ws --port 7000 --persist pi-acp
