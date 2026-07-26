# Panel Next.js — build desde la raíz del monorepo (RAILWAY_DOCKERFILE_PATH=apps/web/Dockerfile)
FROM node:22-alpine
RUN apk add --no-cache libc6-compat
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

# API_URL se inyecta en build (NEXT_PUBLIC_API_URL queda inlined en el bundle)
ARG API_URL
ENV API_URL=$API_URL
RUN pnpm exec turbo run build --filter=@conversia/web

ENV NODE_ENV=production
# next start respeta PORT (Railway lo inyecta)
CMD ["pnpm", "--filter", "@conversia/web", "start"]
