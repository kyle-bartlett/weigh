# The hub image. Zero build step: Bun runs the TypeScript as is. State lives in /data (mount a volume).
FROM oven/bun:1.4-slim

ENV NODE_ENV=production \
    PORT=8787 \
    WEIGH_DB=/data/weigh.db \
    REQUIRE_SECRETS=1

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY web ./web

RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8787/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/cli.ts", "hub"]
