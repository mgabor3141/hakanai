# The real ephemeral agent: pi driven over ACP, exposed as a websocket.
#
# pi-acp speaks ACP (JSON-RPC) over stdio and spawns `pi --mode rpc` next to it;
# @rebornix/stdio-to-ws wraps that stdio into a websocket the control plane dials.
# Baked + immutable: no bind-mount at runtime; everything pi writes goes to /work
# (the disposable volume). pi holds no creds in the image -- the model endpoint
# (Vertex) is the only thing the egress proxy lets it reach.
#
# TODO(seam: pinning) pin oven/bun + the npm versions; bump via Renovate.
# TODO(seam: baked home) bake the ephemeral pi profile (settings, AGENTS.md:
#   "you are an ephemeral assistant; results stay in chat") instead of defaults.
FROM oven/bun:1-alpine
RUN apk add --no-cache nodejs npm \
  && npm i -g pi-acp @earendil-works/pi-coding-agent @rebornix/stdio-to-ws \
  && npm cache clean --force
RUN mkdir -p /work
WORKDIR /work
EXPOSE 7000
# Wrap pi-acp's stdio ACP into a ws endpoint (options first, then the command).
# --persist keeps pi alive across ws reconnects (resume).
CMD ["stdio-to-ws", "--port", "7000", "--persist", "pi-acp"]
