# API NestJS — build desde la raíz del monorepo (RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile)
FROM node:22-alpine
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
# Compila la api y sus dependencias de workspace (incluye prisma generate)
RUN pnpm exec turbo run build --filter=@conversia/api...

ENV NODE_ENV=production
CMD ["node", "apps/api/dist/main.js"]
