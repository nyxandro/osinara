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
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run typecheck && npm run build && npm run build:runtime

FROM dependencies AS test
COPY . .
CMD ["npm", "test"]

# Runtime images install only production packages; build tooling and TypeScript stay behind.
FROM first-party-node AS production-dependencies
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY scripts/apply-eve-patches.ts ./scripts/apply-eve-patches.ts
RUN npm ci --omit=dev

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
