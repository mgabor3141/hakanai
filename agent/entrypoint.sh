#!/bin/sh
# Write pi's defaults so the native Vertex provider is selected without
# interactive choice, then launch pi-acp wrapped to a websocket.
#
# The agent uses pi's built-in `google-vertex` provider, but each model's baseUrl
# points at the inference sidecar (see the baked models.json), and the only
# credential here is a PLACEHOLDER (GOOGLE_CLOUD_API_KEY) -- the real Google
# credential lives in the sidecar, never in this container. GOOGLE_CLOUD_PROJECT
# / GOOGLE_CLOUD_LOCATION are injected at runtime (non-secret) so pi builds the
# correct Vertex request path; the sidecar swaps in the real access token.
set -e
mkdir -p "$HOME/.pi/agent"
cat > "$HOME/.pi/agent/settings.json" <<EOF
{
  "defaultProvider": "google-vertex",
  "defaultModel": "${HAKANAI_MODEL:-gemini-2.5-pro}",
  "defaultProjectTrust": "always",
  "quietStartup": true
}
EOF
exec stdio-to-ws --port 7000 --persist pi-acp
