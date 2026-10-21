# Render worker: Node (Remotion, the bot, the API) + Python (Kokoro voice, faster-whisper check).
# Build context is the repo root (see compose.pipeline.yml).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv ca-certificates curl fonts-dejavu-core \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
      libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir kokoro-onnx==0.6.1 soundfile==0.13.1 faster-whisper==1.2.0

WORKDIR /app/worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && (npx remotion browser ensure || echo "Chrome download failed; Remotion retries on the first render")

COPY worker/ ./
COPY sql/ /app/sql/
# Pre-build the video templates so renders start fast.
RUN npx remotion bundle remotion/index.ts --out-dir /app/bundle

ENV NODE_ENV=production PYTHON_BIN=/opt/py/bin/python REMOTION_BUNDLE=/app/bundle MODELS_DIR=/models
EXPOSE 8080
CMD ["npm", "start"]
