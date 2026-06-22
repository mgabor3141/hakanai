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
# TODO(seam: pinning) pin oven/bun + npm + apk + pip versions; bump via Renovate.
FROM oven/bun:1-alpine

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
      python-docx python-pptx openpyxl pypdf \
  && npm i -g pi-acp @earendil-works/pi-coding-agent @earendil-works/pi-ai @rebornix/stdio-to-ws \
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
