# Multi-stage build: compile server + UI, then a slim multi-runtime image.

# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
RUN npm run build:server && npm run build:ui

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    MCP_DATA_DIR=/data \
    MCP_UI_DIST=/app/ui/dist

# Multi-runtime pool: Node (image), Python via uv, git for the import engine,
# and native binaries can execute directly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-venv curl ca-certificates openssh-client \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
 && rm -rf /var/lib/apt/lists/* /root/.cache

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/ui/dist ./ui/dist

RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/mcp/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/src/index.js"]
