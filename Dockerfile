# syntax=docker/dockerfile:1.7
# ----------------------------------------------------------------------------
# receivable-wa: WhatsApp Web (Baileys) sidecar for receivable-api.
#   builder -> installs deps (git is needed: Baileys pulls libsignal from
#              GitHub) and compiles TypeScript to dist/
#   runtime -> node alpine, non-root, prod deps + dist only
# Internal service: it must NOT be published to the internet.
# ----------------------------------------------------------------------------
ARG NODE_VERSION=22.22.2

FROM node:${NODE_VERSION}-alpine AS builder
RUN apk add --no-cache git && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production WA_PORT=4020
WORKDIR /app
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 4020
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4020/health || exit 1
CMD ["node", "dist/index.js"]
