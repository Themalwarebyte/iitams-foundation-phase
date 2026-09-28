# ---------------------------------------------------------------------------
# IITAMS — multi-stage build for self-hosted deployments
# ---------------------------------------------------------------------------
# Build:   docker build -t iitams-web .
# Run:     docker run -p 8080:80 iitams-web
#
# The web tier is a static SPA; the backend is Convex (see
# docs/SELF_HOSTING_ARCHITECTURE.md for the full topology and how to point the
# client at your own Convex deployment).
# ---------------------------------------------------------------------------

# Stage 1 — build the SPA
FROM oven/bun:1 AS build
WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# VITE_CONVEX_URL is baked at build time; pass it here:
#   docker build --build-arg VITE_CONVEX_URL=https://your.deploy.convex.cloud .
ARG VITE_CONVEX_URL
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL

RUN bun run build

# Stage 2 — serve with nginx
FROM nginx:1.27-alpine AS runtime
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
