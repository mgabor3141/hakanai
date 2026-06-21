# The baked, immutable ephemeral image. No bind-mount at runtime: everything the
# agent needs is in the image; everything it writes goes to /work (a disposable
# volume). TODO(seam: pinning) pin oven/bun by @sha256 digest, bump via Renovate.
FROM oven/bun:1-alpine

WORKDIR /app
COPY agent.ts .

# /work is the disposable volume mount point (the only writable, PII-bearing
# surface). Declared so it exists even before the volume is attached.
RUN mkdir -p /work
EXPOSE 7000

CMD ["bun", "agent.ts"]
