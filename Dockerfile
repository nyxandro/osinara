ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS node-base

FROM node-base AS first-party-node
ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION
LABEL org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}"

# The agent cuts the middle frame of a Telegram GIF, an H.264 MP4 a chat participant sent, with its
# own FFmpeg build that reads only MP4 (H.264) and GIF from a descriptor, opens no path and writes only
# JPEG: a decoder is where a crafted file attacks, and Debian's full ffmpeg would add 200 packages and
# 481 MB. Release 9.0.2 of 18.09.2026, signed by the FFmpeg release key
# FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8; the checksum pins the verified tarball. License
# and source: THIRD_PARTY_NOTICES.md. Built from `node-base`, without the release labels, so the
# stage stays cached from one release to the next.
FROM node-base AS media-tools
ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
RUN apt-get update \
    && apt-get install --no-install-recommends --yes build-essential ca-certificates curl nasm xz-utils \
    && rm -rf /var/lib/apt/lists/*
# ffmpeg.org drops connections now and then (04.11.2026: a timeout, then two TLS failures in a row,
# each failing the whole build). A bounded retry of the download is safe: the archive is checked by
# its SHA-256 right after, and every attempt shows in the build log.
RUN curl --fail --show-error --location --connect-timeout 30 --retry 5 --retry-delay 10 --retry-all-errors \
      "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" --output /tmp/ffmpeg.tar.xz \
    && printf '%s  %s\n' "$FFMPEG_SHA256" /tmp/ffmpeg.tar.xz | sha256sum --check - \
    && mkdir /tmp/ffmpeg \
    && tar --extract --xz --file /tmp/ffmpeg.tar.xz --directory /tmp/ffmpeg --strip-components=1 \
    && cd /tmp/ffmpeg \
    && ./configure --prefix=/opt/ffmpeg \
      --disable-everything --disable-autodetect --disable-network \
      --disable-doc --disable-debug --disable-ffplay --disable-avdevice \
      --enable-protocol=fd,pipe --enable-demuxer=mov,gif \
      --enable-decoder=h264,gif --enable-parser=h264,gif \
      --enable-encoder=mjpeg --enable-muxer=image2pipe --enable-filter=select,scale,format \
    && make -j"$(nproc)" \
    && make install \
    && install -D --mode=0644 COPYING.LGPLv2.1 /opt/ffmpeg/share/doc/ffmpeg/COPYING.LGPLv2.1 \
    && rm -rf /tmp/ffmpeg /tmp/ffmpeg.tar.xz
# A decoder taken over by a crafted file must reach nothing: the agent runs every media tool inside
# media-sandbox (Landlock: no file but the tool and the system libraries, no TCP; seccomp: no
# socket). Built after FFmpeg, so a change here keeps FFmpeg's layer cached; static, so it needs no
# library of its own.
COPY services/media-sandbox/media-sandbox.c /tmp/media-sandbox.c
RUN gcc -O2 -static -Wall -Wextra -Werror -o /opt/ffmpeg/bin/media-sandbox /tmp/media-sandbox.c \
    && rm /tmp/media-sandbox.c

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
COPY --from=media-tools /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /opt/ffmpeg/bin/media-sandbox /usr/local/bin/
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
      libreoffice-calc \
      libreoffice-writer \
      pandoc \
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
COPY --from=media-tools /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /opt/ffmpeg/bin/media-sandbox /usr/local/bin/
COPY --from=media-tools /opt/ffmpeg/share/doc/ffmpeg/COPYING.LGPLv2.1 /usr/local/share/doc/ffmpeg/COPYING.LGPLv2.1
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/.runtime ./.runtime
# The agent runs from `.runtime`; this tree holds its authored files (`instructions.md`) and serves the
# operator's manual `tsx` commands after a release (the software update check).
COPY --from=build /app/agent ./agent
COPY --from=build /app/config ./config
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./package.json
# The license and attribution of the adapted third-party code under `agent/runtime/`.
COPY --from=build /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
# The deployment controller travels with the release it deploys. The app image digest is bound by
# the approved manifest, so a host takes the controller and its units from here, not from GitHub.
COPY scripts/production-deploy/ ./deploy/controller/
COPY infra/systemd/ ./deploy/systemd/
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
