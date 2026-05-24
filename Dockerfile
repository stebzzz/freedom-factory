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
RUN npm install -g npm@11
COPY package.json package-lock.json ./
# `npm install` (lenient) instead of `npm ci` (strict). `npm ci` rejects
# the lock with "Invalid: lock file's ajv@6.14.0 does not satisfy
# ajv@8.20.0" on linux/x64 even though the lock validates on darwin/arm64
# where it was generated — looks like a platform-specific optional-deps
# tree mismatch. `npm install` resolves nested versions on the fly.
RUN npm install --no-audit --no-fund

# ─── Stage 2: builder ───────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g npm@11
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

# Whisper transcription is handled by the OpenAI API (lib/api/whisper.ts:
# transcribeWithOpenAI). We don't build whisper.cpp locally anymore — it cost
# ~10 min per deploy (git clone + cmake build + model download, all on a VPS
# that crawls at ~15 KiB/s) for a feature that's now a cold fallback at best.
# If we ever need offline transcription again, restore the previous block from
# git history (commit 7c4eeb8).

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
