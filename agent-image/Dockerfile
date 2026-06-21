# Stub ACP agent image (fast, model-free). Speaks the same ACP-over-stdio-wrapped
# -to-ws transport as the real agent (agent-pi/), so the browser + smokes drive
# the real protocol without a model. Everything it writes goes to /work (the
# disposable volume); no bind-mount at runtime.
# TODO(seam: pinning) pin oven/bun + stdio-to-ws; bump via Renovate.
FROM oven/bun:1-alpine
RUN apk add --no-cache nodejs npm \
  && npm i -g @rebornix/stdio-to-ws \
  && npm cache clean --force
WORKDIR /app
COPY agent.ts .
RUN mkdir -p /work
EXPOSE 7000
# Wrap the stdio ACP agent into a ws endpoint (options first, then the command).
CMD ["stdio-to-ws", "--port", "7000", "--persist", "bun /app/agent.ts"]
