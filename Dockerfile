# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The bundled hoi4-engine (ADR 0074). Releases replace this empty stage with `engine/bin` through
# the named build context `engine-bin`; a plain build has no engine and reports it unavailable.
FROM scratch AS engine-bin

FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS build
ARG TARGETARCH
ARG REQUIRE_ENGINE=0
WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY docs/README.md docs/setup.md docs/focus.md docs/gui.md docs/map.md docs/http.md docs/development.md ./docs/
COPY server.json README.md LICENSE SECURITY.md CHANGELOG.md ./
RUN npm run build && npm prune --omit=dev
RUN --mount=type=bind,from=engine-bin,target=/engine-bin     set -eu;     case "$TARGETARCH" in amd64) platform=linux-x64 ;; arm64) platform=linux-arm64 ;; *) platform=none ;; esac;     mkdir -p engine/bin;     if [ -f "/engine-bin/$platform/hoi4-engine" ]; then       cp /engine-bin/manifest.json engine/bin/;       mkdir "engine/bin/$platform";       cp "/engine-bin/$platform/hoi4-engine" "engine/bin/$platform/";       chmod 755 "engine/bin/$platform/hoi4-engine";       "engine/bin/$platform/hoi4-engine" --version;     elif [ "$REQUIRE_ENGINE" = 1 ]; then       echo "The engine-bin context has no hoi4-engine for $platform" >&2;       exit 1;     fi

FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS runtime
LABEL org.opencontainers.image.source="https://github.com/klimPaskov/hoi4-agent-tools"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.klimPaskov/hoi4-agent-tools"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/npm-shrinkwrap.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/engine ./engine
COPY --from=build --chown=node:node /app/docs ./docs
COPY --from=build --chown=node:node /app/server.json /app/README.md /app/LICENSE /app/SECURITY.md /app/CHANGELOG.md ./
USER node
EXPOSE 3210
ENTRYPOINT ["node", "dist/bin/http.js"]
