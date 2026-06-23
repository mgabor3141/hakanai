# The control plane: persistent infrastructure (NOT the PII boundary), so unlike
# the agent image it may hold long-lived code and talk to the docker socket.
# Needs the docker CLI to orchestrate sibling containers.
# Base image pinned by digest; the tag is kept in the comment so Renovate can
# track it and bump the digest via PR. (renovate.json)
FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
CMD ["bun", "server.ts"]
