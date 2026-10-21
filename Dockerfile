# The hub image. Zero build step: Bun runs the TypeScript as is. State lives in /data (mount a volume).
FROM oven/bun:1.4-slim

ENV NODE_ENV=production \
    PORT=8787 \
    WEIGH_DB=/data/weigh.db \
    REQUIRE_SECRETS=1

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
# The slim base uses glibc; Bun can install both GNU and musl optional builds.
RUN bun -e 'const fs = require("node:fs"); const keep = `resvg-js-linux-${process.arch}-gnu`; const dir = "node_modules/@resvg"; if (!fs.existsSync(`${dir}/${keep}`)) throw new Error(`Missing ${keep}`); for (const name of fs.readdirSync(dir)) if (name.startsWith("resvg-js-") && name !== keep) fs.rmSync(`${dir}/${name}`, { recursive: true, force: true }); require("@resvg/resvg-js");'
COPY src ./src
COPY web ./web

RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8787/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/cli.ts", "hub"]
