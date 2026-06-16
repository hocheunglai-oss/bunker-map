FROM node:20-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG DEPLOY_COMMIT=unknown
ARG DEPLOY_BRANCH=unknown
ARG DEPLOYED_AT=unknown
ENV DEPLOY_COMMIT=$DEPLOY_COMMIT
ENV DEPLOY_BRANCH=$DEPLOY_BRANCH
ENV DEPLOYED_AT=$DEPLOYED_AT
ENV NEXT_PUBLIC_DEPLOY_COMMIT=$DEPLOY_COMMIT

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000
CMD ["npm", "run", "start"]
