FROM node:24-bookworm-slim AS frontend
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY web ./web
COPY config/cost-routing-compatibility.json config/service-models.json ./config/
COPY public ./public
RUN pnpm check:web:vue && pnpm build:web

FROM node:24-bookworm-slim AS runtime
ARG CODEX_VERSION=0.155.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates chromium xvfb fonts-liberation util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_VERSION} && npm cache clean --force
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-workspace
COPY server.js ./
COPY src ./src
COPY public ./public
COPY --from=frontend /app/public/vue ./public/vue
COPY --from=frontend /app/public/vue /opt/media-vue
COPY config ./config
COPY scripts/migrate-content-assets.cjs scripts/audit-content.cjs scripts/migrate-schema.cjs scripts/grant-runtime-role.cjs scripts/database-preflight.cjs scripts/read-system-errors.cjs scripts/check-operations-alerts.cjs scripts/resolve-git-commit.cjs ./scripts/
COPY scripts/audit-provider-quotes.cjs ./scripts/
COPY scripts/import-service-model-config.cjs ./scripts/
COPY .git /tmp/media-git
RUN node scripts/resolve-git-commit.cjs /tmp/media-git > /opt/media-commit && rm -rf /tmp/media-git
RUN node src/server/build-info.js /opt/media-build.json /opt/media-commit
RUN mkdir -p data/service data/codex-auth && chown -R node:node data
USER node
ENV MEDIA_HOST=0.0.0.0 MEDIA_CODEX_EMBEDDED=true CODEX_HOME=/app/data/codex-auth MEDIA_KIE_BROWSER_EMBEDDED=true MEDIA_VUE_ROOT=/opt/media-vue
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.MEDIA_PORT||process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "mkdir -p \"${MEDIA_DATA_DIR:-data/service}\" && if [ \"${MEDIA_REPLICA_ROLE:-single}\" = web ]; then exec node server.js; else exec flock -F -n -E 73 \"${MEDIA_DATA_DIR:-data/service}/service.lock\" env MEDIA_LOCK_HELD_BY_FLOCK=1 node server.js; fi"]

FROM node:24-bookworm-slim AS test
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY server.js ./
COPY src ./src
COPY public ./public
COPY web ./web
COPY config ./config
COPY scripts/resolve-git-commit.cjs ./scripts/
COPY scripts/check-server-syntax.cjs ./scripts/
COPY scripts/check-async-safety.cjs ./scripts/
COPY .git /tmp/media-git
RUN node scripts/resolve-git-commit.cjs /tmp/media-git > /opt/media-commit && rm -rf /tmp/media-git
COPY test ./test
COPY tools/load-test ./tools/load-test
CMD ["node", "--test", "test/*.test.js"]

FROM runtime AS browser-test
COPY --chown=node:node test/browser-e2e.cjs ./test/

FROM runtime AS production
