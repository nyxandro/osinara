ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS first-party-node
ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION
LABEL org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}"

FROM first-party-node AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/apply-eve-patches.ts ./scripts/apply-eve-patches.ts
COPY scripts/apply-openai-compatible-patches.ts ./scripts/apply-openai-compatible-patches.ts
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run typecheck && npm run build && npm run build:runtime

FROM dependencies AS test
RUN apt-get update \
    && apt-get install --no-install-recommends --yes jq \
    && rm -rf /var/lib/apt/lists/*
COPY . .
CMD ["npm", "test"]

# Runtime images install only production packages; build tooling and TypeScript stay behind.
FROM first-party-node AS production-dependencies
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY scripts/apply-eve-patches.ts ./scripts/apply-eve-patches.ts
COPY scripts/apply-openai-compatible-patches.ts ./scripts/apply-openai-compatible-patches.ts
RUN npm ci --omit=dev

FROM eceasy/cli-proxy-api@sha256:0b27437917e45a22612ff43ede0fd6baf077c1898c622037a24a79399a9b3d0c AS cli-proxy
ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION
LABEL org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}"
RUN apt-get update \
    && apt-get install --no-install-recommends --yes curl jq \
    && groupadd --gid 10001 cli-proxy \
    && useradd --gid cli-proxy --no-create-home --uid 10001 --shell /usr/sbin/nologin cli-proxy \
    && install -d -o cli-proxy -g cli-proxy -m 0700 /config /run/cli-proxy-api \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=cli-proxy:cli-proxy config/model-providers.json /config/model-providers.json
COPY --chown=root:root infra/cli-proxy-entrypoint.sh /usr/local/bin/osinara-cli-proxy-entrypoint
RUN chmod 0555 /usr/local/bin/osinara-cli-proxy-entrypoint
USER cli-proxy
ENTRYPOINT ["osinara-cli-proxy-entrypoint", "/config/model-providers.json", "/run/cli-proxy-api/config.json"]
CMD ["/CLIProxyAPI/CLIProxyAPI", "-config", "/run/cli-proxy-api/config.json"]

FROM first-party-node AS sandbox-runtime
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
      build-essential \
      ca-certificates \
      curl \
      fonts-liberation \
      findutils \
      grep \
      git \
      jq \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      poppler-utils \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      unzip \
      xdg-utils \
      zip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["sleep", "infinity"]

FROM first-party-node AS sandbox-runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/.runtime/services/sandbox-runner/main.js ./.runtime/services/sandbox-runner/main.js
CMD ["node", ".runtime/services/sandbox-runner/main.js"]

FROM first-party-node AS sandbox-egress-proxy
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/.runtime/services/sandbox-egress-proxy/main.js ./.runtime/services/sandbox-egress-proxy/main.js
USER node
CMD ["node", ".runtime/services/sandbox-egress-proxy/main.js"]

FROM first-party-node AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/.eve ./.eve
COPY --from=build /app/.runtime ./.runtime
# Eve 0.22.5 `start` serves `.output` but still bundles authored modules from this tree.
COPY --from=build /app/agent ./agent
COPY --from=build /app/config ./config
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/resources ./resources
COPY --from=build /app/package.json ./package.json
COPY scripts/docker-entrypoint.sh /usr/local/bin/osinara-entrypoint
RUN chmod +x /usr/local/bin/osinara-entrypoint
EXPOSE 3000
ENTRYPOINT ["osinara-entrypoint"]

FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de AS edge
ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION
LABEL org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}"
COPY infra/nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
