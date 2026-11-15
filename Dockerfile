# Next.js app (Flickering Pixels) — production image.
# Build targets:  runner (default, the web server)   migrate (one-shot: applies drizzle/ migrations)

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Rewrites are resolved at build time: point /spherex-api at the Python container.
ARG SPHEREX_API_URL=http://api:8000
ENV SPHEREX_API_URL=$SPHEREX_API_URL \
    NEXT_TELEMETRY_DISABLED=1
# Placeholders so modules that read env at import time can be evaluated during the build.
# Real values are passed at runtime and never baked into the image.
RUN DATABASE_URL=postgres://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-time-placeholder-not-used-at-runtime \
    BETTER_AUTH_URL=http://localhost:3000 GOOGLE_CLIENT_ID=build GOOGLE_CLIENT_SECRET=build \
    npm run build

# One-shot migration runner (has drizzle-kit from devDependencies).
FROM builder AS migrate
CMD ["npx", "drizzle-kit", "migrate"]

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
