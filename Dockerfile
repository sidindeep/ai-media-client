FROM node:24-bookworm-slim AS runtime
ARG CODEX_VERSION=0.155.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_VERSION} && npm cache clean --force
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-workspace
COPY server.js ./
COPY src ./src
COPY public ./public
COPY config ./config
COPY scripts/migrate-content-assets.cjs scripts/audit-content.cjs ./scripts/
RUN node src/server/build-info.js /opt/media-build.json
RUN mkdir -p data/service data/codex-auth && chown -R node:node data
USER node
ENV MEDIA_HOST=0.0.0.0 MEDIA_CODEX_EMBEDDED=true CODEX_HOME=/app/data/codex-auth
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.MEDIA_PORT||process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

FROM node:24-bookworm-slim AS test
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY server.js ./
COPY src ./src
COPY public ./public
COPY config ./config
COPY test ./test
CMD ["node", "--test", "test/*.test.js"]

FROM runtime AS production
