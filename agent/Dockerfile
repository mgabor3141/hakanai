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
# Base image pinned by digest; the tag is kept in the comment so Renovate can
# track it and bump the digest via PR. (renovate.json)
#
# npm globals and pip packages are pinned to exact versions below (Renovate bumps
# them). apk packages are intentionally NOT version-pinned: Alpine repos only
# serve the single current version of each package, so a pinned `pkg=version`
# breaks the build the moment the repo rolls forward. Reproducibility for the
# OS layer comes from the base-image digest instead; Renovate bumps that digest.
FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

# Assistant toolchain (not a dev box): documents, PDFs, images, OCR, and media.
# The agent reasons in text but can act on files with these. py3-lxml/py3-pillow
# come from apk so pip does not have to compile native extensions.
RUN apk add --no-cache \
      nodejs npm \
      python3 py3-pip py3-lxml py3-pillow \
      imagemagick ghostscript poppler-utils \
      tesseract-ocr tesseract-ocr-data-eng \
      pandoc-cli ffmpeg \
      ripgrep jq file less font-dejavu \
  && pip install --no-cache-dir --break-system-packages \
      python-docx==1.2.0 python-pptx==1.0.2 openpyxl==3.1.5 pypdf==6.14.2 \
  && npm i -g pi-acp@0.0.31 @earendil-works/pi-coding-agent@0.79.10 @earendil-works/pi-ai@0.79.10 @rebornix/stdio-to-ws@0.2.0 \
  && npm cache clean --force \
  && sed -i '1s|.*|#!/usr/bin/env bun|' "$(readlink -f "$(command -v pi)")"

ENV HOME=/root
RUN mkdir -p /work /root/.pi/agent/extensions
COPY extensions/ /root/.pi/agent/extensions/
COPY AGENTS.md /root/.pi/agent/AGENTS.md
COPY entrypoint.sh /usr/local/bin/hakanai-agent
RUN chmod +x /usr/local/bin/hakanai-agent
WORKDIR /work
EXPOSE 7000
CMD ["hakanai-agent"]
