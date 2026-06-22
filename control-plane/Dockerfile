# The control plane: persistent infrastructure (NOT the PII boundary), so unlike
# the agent image it may hold long-lived code and talk to the docker socket.
# Needs the docker CLI to orchestrate sibling containers.
# TODO(seam: pinning) pin oven/bun by @sha256 digest, bump via Renovate.
FROM oven/bun:1-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
CMD ["bun", "server.ts"]
