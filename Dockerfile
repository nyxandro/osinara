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
COPY scripts/install-google-workspace-cli.ts ./scripts/install-google-workspace-cli.ts
RUN npm ci --ignore-scripts \
    && npm run install:gws

FROM dependencies AS build
COPY . .
RUN npm run typecheck && npm run build

# Release-only artifact stage: output is one SEA executable, never a deployable container image.
FROM build AS installer-cli-build
ARG INSTALLATION_ARCHIVE_SHA256
ARG INSTALLATION_RELEASE_VERSION
RUN bash scripts/provider-installer/build-provider-installer-cli.sh \
    /tmp/osinara-linux-x64 "$INSTALLATION_RELEASE_VERSION" "$INSTALLATION_ARCHIVE_SHA256"

FROM scratch AS installer-cli-artifact
COPY --from=installer-cli-build /tmp/osinara-linux-x64 /osinara-linux-x64

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
COPY scripts/install-google-workspace-cli.ts ./scripts/install-google-workspace-cli.ts
RUN npm ci --omit=dev --ignore-scripts \
    && npm run install:gws

# Codex subscription gateway stays digest-pinned and exposes no management surface.
FROM eceasy/cli-proxy-api@sha256:591a09c19de769be09a2e56277365cd568b83fc7d98c94d2e7e7bef7069f7422 AS cli-proxy
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
    && install -d -o cli-proxy -g cli-proxy -m 0700 /run/cli-proxy-api /var/lib/cli-proxy-api/auth \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=root:root infra/cli-proxy-entrypoint.sh /usr/local/bin/osinara-cli-proxy-entrypoint
RUN chmod 0555 /usr/local/bin/osinara-cli-proxy-entrypoint
USER cli-proxy
ENTRYPOINT ["osinara-cli-proxy-entrypoint", "/var/lib/cli-proxy-api/auth", "/run/cli-proxy-api/config.json"]
CMD ["/CLIProxyAPI/CLIProxyAPI", "-config", "/run/cli-proxy-api/config.json"]

FROM first-party-node AS sandbox-runtime
COPY infra/certificates/russian-trusted-root-ca.crt /usr/local/share/ca-certificates/russian-trusted-root-ca.crt
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
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=production-dependencies \
  /app/node_modules/@googleworkspace/cli/bin/gws \
  /opt/osinara/gws
COPY infra/sandbox-tools/package.json infra/sandbox-tools/package-lock.json /opt/sandbox-tools/
RUN npm ci --ignore-scripts --prefix /opt/sandbox-tools \
    && node /opt/sandbox-tools/node_modules/agent-browser/scripts/postinstall.js \
    && ln -s /opt/sandbox-tools/node_modules/.bin/agent-browser /usr/local/bin/agent-browser \
    && curl --fail --show-error --location \
      https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.82/linux64/chrome-linux64.zip \
      --output /tmp/chrome-linux64.zip \
    && printf '%s  %s\n' 0704631fb3e4f741092e08f55272f90abc3e307f991f05f332924364415b02e0 /tmp/chrome-linux64.zip | sha256sum --check - \
    && unzip -q /tmp/chrome-linux64.zip -d /opt/sandbox-tools \
    && rm /tmp/chrome-linux64.zip \
    && ln -s /opt/sandbox-tools/chrome-linux64/chrome /usr/local/bin/osinara-chromium
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
RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/.runtime ./.runtime
# The agent runs from `.runtime`; this tree holds its authored files (`instructions.md`) and serves the
# operator's manual `tsx` commands after a release (the software update check).
COPY --from=build /app/agent ./agent
COPY --from=build /app/config ./config
COPY --from=build /app/migrations ./migrations
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
