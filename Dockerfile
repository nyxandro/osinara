FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/apply-eve-patches.ts ./scripts/apply-eve-patches.ts
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run typecheck && npm run build

FROM dependencies AS test
COPY . .
CMD ["npm", "test"]

FROM node:24-bookworm-slim AS document-parser
RUN apt-get update \
    && apt-get install --no-install-recommends --yes poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/document-parser/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

FROM node:24-bookworm-slim AS sandbox-runtime
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

FROM dependencies AS sandbox-runner
COPY agent/config.ts ./agent/config.ts
COPY agent/lib/sandbox-runner ./agent/lib/sandbox-runner
COPY services/sandbox-runner ./services/sandbox-runner
CMD ["node", "--import", "tsx", "services/sandbox-runner/main.ts"]

FROM dependencies AS sandbox-egress-proxy
COPY services/sandbox-egress-proxy ./services/sandbox-egress-proxy
USER node
CMD ["node", "--import", "tsx", "services/sandbox-egress-proxy/main.ts"]

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/.eve ./.eve
COPY --from=build /app/agent ./agent
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
COPY scripts/docker-entrypoint.sh /usr/local/bin/osinara-entrypoint
RUN chmod +x /usr/local/bin/osinara-entrypoint
EXPOSE 3000
ENTRYPOINT ["osinara-entrypoint"]
