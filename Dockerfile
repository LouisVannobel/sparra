# syntax=docker/dockerfile:1
FROM node:24.14.0-bookworm-slim@sha256:4bd6219054c8bebcd26a66bfd8ca0bd6e1024b4b97474c59bb7ee3bbcbef4fe8 AS builder
WORKDIR /app
RUN test "$(node --version)" = v24.14.0 && corepack enable && corepack prepare pnpm@10.32.1 --activate && test "$(pnpm --version)" = 10.32.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts vite.worker.config.ts Dockerfile ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tools ./tools
COPY drizzle ./drizzle
RUN pnpm run build && node scripts/migration-source-manifest.mjs --write && node scripts/web-source-manifest.mjs --write

FROM builder AS migration-dependencies
# The native Node migrator never invokes Drizzle Kit's retained esbuild compilers.
RUN --network=none sha256sum pnpm-lock.yaml > /tmp/lock.sha256 && pnpm prune --prod \
    && rm -f \
      /app/node_modules/.pnpm/@esbuild+linux-x64@0.18.20/node_modules/@esbuild/linux-x64/bin/esbuild \
      /app/node_modules/.pnpm/esbuild@0.18.20/node_modules/esbuild/bin/esbuild \
      /app/node_modules/.pnpm/@esbuild+linux-x64@0.25.12/node_modules/@esbuild/linux-x64/bin/esbuild \
      /app/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild \
    && sha256sum -c /tmp/lock.sha256

FROM node:24.14.0-bookworm-slim@sha256:4bd6219054c8bebcd26a66bfd8ca0bd6e1024b4b97474c59bb7ee3bbcbef4fe8 AS runtime-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade \
      libcap2=1:2.66-4+deb12u3+b1 \
      libgnutls30=3.7.9-2+deb12u7 \
      libpcre2-8-0=10.42-1+deb12u2 \
      perl-base=5.36.0-7+deb12u4 \
    && rm -rf /var/lib/apt/lists/*
RUN rm -rf /usr/local/lib/node_modules /opt/yarn* /root/.cache /root/.npm && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg && test "$(node --version)" = v24.14.0
WORKDIR /app

FROM runtime-base AS migrator
COPY --from=migration-dependencies /app/package.json /app/pnpm-lock.yaml /app/migration-source-manifest.json ./
COPY --from=migration-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts/migrate.ts /app/scripts/start-migrate.mjs /app/scripts/migration-credentials.mjs /app/scripts/fixed-credential-file.mjs ./scripts/
COPY --from=builder /app/src/platform/config.server.ts ./src/platform/
COPY --from=builder /app/src/platform/db/config.server.ts ./src/platform/db/
COPY --from=builder /app/src/modules/auth/auth-email-normalization.server.ts ./src/modules/auth/
RUN chmod -R a-w /app
USER 10001:10001
ENTRYPOINT ["node","scripts/start-migrate.mjs"]

FROM runtime-base AS web
COPY --from=builder /app/web-source-manifest.json ./
COPY --from=builder /app/.output/server ./.output/server
COPY --from=builder /app/.output/public ./.output/public
COPY --from=builder /app/scripts/start-web.mjs /app/scripts/web-credentials.mjs /app/scripts/fixed-credential-file.mjs ./scripts/
RUN chmod -R a-w /app
USER 10001:10001
ENTRYPOINT ["node","scripts/start-web.mjs"]
