# The egress chokepoint image. Tiny; the allowlist is passed at runtime via ALLOW.
# TODO(seam: pinning) pin oven/bun by @sha256 digest, bump via Renovate.
FROM oven/bun:1-alpine
WORKDIR /app
COPY proxy.ts .
EXPOSE 8888
CMD ["bun", "proxy.ts"]
