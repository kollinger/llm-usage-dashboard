FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY scripts ./scripts
COPY lib ./lib
COPY server.js README.md ./

EXPOSE 4177 11435

CMD ["node", "server.js"]
