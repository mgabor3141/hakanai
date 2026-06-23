# The egress chokepoint image. Tiny; the allowlist is passed at runtime via ALLOW.
# Base image pinned by digest; the tag is kept in the comment so Renovate can
# track it and bump the digest via PR. (renovate.json)
FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
WORKDIR /app
COPY proxy.ts .
EXPOSE 8888
CMD ["bun", "proxy.ts"]
