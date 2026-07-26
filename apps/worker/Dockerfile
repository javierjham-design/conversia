# Worker BullMQ — build desde la raíz del monorepo (RAILWAY_DOCKERFILE_PATH=apps/worker/Dockerfile)
FROM node:22-alpine
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@conversia/worker...

ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/main.js"]
