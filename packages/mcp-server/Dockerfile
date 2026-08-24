FROM node:24.13.0-bookworm-slim

RUN corepack enable \
  && corepack prepare pnpm@10.15.0 --activate \
  && apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/nexus-engine
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "packages/mcp-server/dist/mcp-server/src/server.js"]
