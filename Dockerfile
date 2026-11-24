# Railway builds this automatically (see railway.json). FFmpeg/ffprobe are required for
# smart video comparison; exact duplicate detection works without them.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Temporary media lives here and is cleaned after every job.
ENV TEMP_DIR=/tmp/tele-dupbot
USER node

# tini forwards SIGTERM so the bot can finish in-flight jobs on Railway redeploys.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
