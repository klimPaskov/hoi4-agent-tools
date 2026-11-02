# Head-to-head image (decision M-7): hoi4-agent-tools and cpntodd/HOI4-MCP side by side, driven
# by driver.py. Build context: a folder holding `ours/` (a checkout of this repository) and
# `theirs/` (HOI4-MCP at the pinned commit). Built with network; run with --network none.
FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS ours
WORKDIR /app
COPY ours/package.json ours/npm-shrinkwrap.json ./
RUN npm ci
COPY ours/tsconfig.json ours/tsconfig.build.json ./
COPY ours/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
COPY theirs/hoi4-mcp-server /opt/hoi4-mcp-src
RUN python3 -m venv /opt/hoi4-mcp \
  && /opt/hoi4-mcp/bin/pip install --no-cache-dir -c /opt/hoi4-mcp-src/constraints.txt /opt/hoi4-mcp-src
COPY --from=ours /app /opt/hoi4-agent-tools
ENV PATH=/opt/hoi4-mcp/bin:$PATH
WORKDIR /work
ENTRYPOINT ["/opt/hoi4-mcp/bin/python", "/bench/driver.py", "/bench/tasks.json"]
