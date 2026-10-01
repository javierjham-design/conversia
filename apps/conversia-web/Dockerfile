# Frontend Conversia — build desde la raíz del monorepo
# (RAILWAY_DOCKERFILE_PATH=apps/conversia-web/Dockerfile). Comparte api/worker/BD con TuBot.
FROM node:22-alpine
RUN apk add --no-cache libc6-compat
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

# NEXT_PUBLIC_API_URL se INLINEA en build (es NEXT_PUBLIC_*). Railway lo pasa como build
# arg del servicio; apunta a la api EXISTENTE (no hay backend propio).
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm exec turbo run build --filter=@conversia/conversia-web

ENV NODE_ENV=production
# next start respeta PORT (Railway lo inyecta).
CMD ["pnpm", "--filter", "@conversia/conversia-web", "start"]
