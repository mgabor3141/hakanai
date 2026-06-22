# The ephemeral agent: pi driven over ACP, exposed as a websocket.
#
# pi-acp speaks ACP (JSON-RPC) over stdio and spawns `pi --mode rpc`; @rebornix/
# stdio-to-ws wraps that stdio into a ws endpoint the control plane dials. Baked
# + immutable: no bind-mount; everything pi writes goes to /work (disposable).
#
# pi is a Node program, but we run it under bun (node-compatibility mode, as hako
# does) by flipping its shebang -- because bun's fetch honors HTTPS_PROXY and the
# egress proxy is the agent's ONLY route to the model endpoint. (Node's undici
# fetch ignores the proxy env, which would strand the agent.)
#
# Model auth is injected at runtime (HAKANAI_MODEL_BASE_URL / _API_KEY); the
# hakanai-inference extension registers the OpenAI-compatible provider. No creds
# are baked into the image.
# TODO(seam: pinning) pin oven/bun + npm versions; bump via Renovate.
FROM oven/bun:1-alpine
RUN apk add --no-cache nodejs npm \
  && npm i -g pi-acp @earendil-works/pi-coding-agent @rebornix/stdio-to-ws \
  && npm cache clean --force \
  && sed -i '1s|.*|#!/usr/bin/env bun|' "$(readlink -f "$(command -v pi)")"
ENV HOME=/root
RUN mkdir -p /work /root/.pi/agent/extensions
COPY extensions/hakanai-inference.ts /root/.pi/agent/extensions/hakanai-inference.ts
COPY entrypoint.sh /usr/local/bin/hakanai-agent
RUN chmod +x /usr/local/bin/hakanai-agent
WORKDIR /work
EXPOSE 7000
CMD ["hakanai-agent"]
