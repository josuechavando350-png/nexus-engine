FROM node:24.13.0-bookworm-slim

RUN corepack enable \
  && corepack prepare pnpm@10.15.0 --activate \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/nexus-engine
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @nexus/ontology build

RUN mkdir -p /var/lib/nexus-cortex /etc/nexus-cortex \
  && chown node:node /var/lib/nexus-cortex \
  && chmod 0700 /var/lib/nexus-cortex \
  && chmod 0755 /etc/nexus-cortex

ENV NODE_ENV=production \
  PORT=8789 \
  NEXUS_CORTEX_STATE_DB=/var/lib/nexus-cortex/behavioral-signals.sqlite \
  NEXUS_CORTEX_PERSISTENCE_ACK=durable-volume \
  NEXUS_CORTEX_BEHAVIORAL_CONFIG=/etc/nexus-cortex/behavioral.json

VOLUME ["/var/lib/nexus-cortex"]
EXPOSE 8789
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'fetch(`http://127.0.0.1:${process.env.PORT || "8789"}/healthz`).then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'

CMD ["node", "scripts/cortex-behavioral-signals.mjs"]
