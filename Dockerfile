# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY docs/README.md docs/setup.md docs/focus.md docs/gui.md docs/map.md docs/http.md docs/development.md ./docs/
COPY server.json README.md LICENSE SECURITY.md CHANGELOG.md ./
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c AS runtime
LABEL org.opencontainers.image.source="https://github.com/klimPaskov/hoi4-agent-tools"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.klimPaskov/hoi4-agent-tools"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/docs ./docs
COPY --from=build --chown=node:node /app/server.json /app/README.md /app/LICENSE /app/SECURITY.md /app/CHANGELOG.md ./
USER node
EXPOSE 3210
ENTRYPOINT ["node", "dist/bin/http.js"]
