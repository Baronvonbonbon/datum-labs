# Generic builder for the DATUM node services (relay, advertiser-cosigner, indexer).
# Used by every service in docker-compose.yml with a per-component build context;
# the CMD is overridden per service. Build tools are present so the indexer's
# better-sqlite3 native module compiles.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (layer cache). package-lock present → ci; else install.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source (node_modules / .env excluded via .dockerignore).
COPY . .

# Overridden per service (relay: node src/index.mjs, cosigner: node src/server.mjs,
# monitor: node scripts/monitor.mjs, topup: node scripts/topup.mjs, indexer: node src/index.js run).
CMD ["node", "--version"]
