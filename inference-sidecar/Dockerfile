# The auth-injecting inference sidecar (see proxy.ts). Holds the Google
# credential, mints/refreshes the Vertex access token, and forwards agent
# requests to real Vertex -- so the credential never enters an agent container.
#
# Base image pinned by digest; tag kept in the comment so Renovate tracks it and
# bumps the digest via PR (renovate.json). bun deps are locked (bun.lock) and
# installed with --frozen-lockfile for reproducibility.
FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY proxy.ts ./

EXPOSE 8900
CMD ["bun", "proxy.ts"]
