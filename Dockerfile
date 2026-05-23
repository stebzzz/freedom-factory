# syntax=docker/dockerfile:1.7
# ────────────────────────────────────────────────────────────────────────
# Freedom Factory — Docker image for Hostinger VPS deployment.
#
# Multi-stage build:
#   1. deps   : install npm deps with build toolchain (sharp, etc.)
#   2. builder: produce the Next.js standalone bundle
#   3. runner : minimal runtime image with ffmpeg/libass, ImageMagick,
#               whisper.cpp, Chromium deps (for Remotion), Python 3 (yt-dlp)
# ────────────────────────────────────────────────────────────────────────

# ─── Stage 1: deps ──────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ─── Stage 2: builder ───────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─── Stage 3: runner (production image) ─────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# System binaries the pipeline shells out to.
#   - ffmpeg + libass  : video concat / subtitle burn-in
#     (Debian's ffmpeg is built with --enable-libass; libass9 pulled as dep)
#   - imagemagick      : attribution overlay (IM6 on bookworm -> use `convert`)
#   - chromium + deps  : @remotion/renderer headless rendering
#   - libvips          : sharp image processing
#   - python3 + venv   : optional yt-dlp scripts
#   - tini             : PID 1 to forward signals to next start
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libass9 \
      imagemagick \
      chromium \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      libvips \
      python3 python3-venv python3-pip \
      ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

# whisper.cpp build (whisper-cli + ggml-large-v3-turbo-q5_0 model)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential cmake \
    && git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /tmp/whisper.cpp \
    && cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DGGML_NATIVE=ON \
    && cmake --build /tmp/whisper.cpp/build --config Release -j \
    && install -m 0755 /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && mkdir -p /root/.cache/whisper-cpp-models \
    && curl -fL -o /root/.cache/whisper-cpp-models/ggml-large-v3-turbo-q5_0.bin \
         https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin \
    && apt-get purge -y --auto-remove git build-essential cmake \
    && rm -rf /tmp/whisper.cpp /var/lib/apt/lists/*

# Hostinger's ImageMagick on Debian disables PDF/SVG/MVG by default — we
# allow them, since style-kit import reads PDFs and overlay uses MVG.
RUN sed -i 's|rights="none" pattern="PDF"|rights="read\|write" pattern="PDF"|' \
      /etc/ImageMagick-6/policy.xml 2>/dev/null || true \
 && sed -i 's|rights="none" pattern="MVG"|rights="read\|write" pattern="MVG"|' \
      /etc/ImageMagick-6/policy.xml 2>/dev/null || true \
 && sed -i 's|rights="none" pattern="SVG"|rights="read\|write" pattern="SVG"|' \
      /etc/ImageMagick-6/policy.xml 2>/dev/null || true

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MAGICK_BIN=/usr/bin/convert \
    WHISPER_CLI_PATH=/usr/local/bin/whisper-cli \
    REMOTION_CHROME_EXECUTABLE=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

# Copy the Next.js standalone bundle (server.js + minimal node_modules)
COPY --from=builder /app/.next/standalone ./
# Static assets and the public/ tree must be served by next start
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Scripts and remotion entry are loaded at runtime by spawn() / Remotion bundler
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/remotion ./remotion
# Config files read at runtime via process.cwd()
COPY --from=builder /app/config ./config

# Persistent dirs (mounted as volumes in docker-compose)
RUN mkdir -p public/generated public/uploads public/style-refs public/sourcing outputs audio mp3

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
