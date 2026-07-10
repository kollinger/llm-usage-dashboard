FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY scripts ./scripts
COPY lib ./lib
COPY server.js README.md ./

EXPOSE 4177 11435

CMD ["node", "server.js"]
