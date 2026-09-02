# Single image used for both the api and worker processes (command differs).
FROM node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install workspace dependencies.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/api/package.json ./apps/api/package.json
RUN npm install

# App source.
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Prisma client for the runtime platform.
RUN npx prisma generate

ENV NODE_ENV=production
EXPOSE 4000

# Applies migrations then starts whichever process the compose command selects.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start:api --workspace @dispatch/api"]
