# Panel Next.js — build desde la raíz del monorepo (RAILWAY_DOCKERFILE_PATH=apps/web/Dockerfile)
FROM node:22-alpine
RUN apk add --no-cache libc6-compat
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

# API_URL se lee en RUNTIME (rewrites de next.config) — no se necesita en build
RUN pnpm exec turbo run build --filter=@conversia/web

ENV NODE_ENV=production
# next start respeta PORT (Railway lo inyecta)
CMD ["pnpm", "--filter", "@conversia/web", "start"]
