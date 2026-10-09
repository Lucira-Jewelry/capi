# The collector: API, website script, admin console. Build:  docker build -t collector .
# Settings come from the environment; see .env.example. NODE_ENV=production makes the server refuse unsafe ones.

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci
COPY scripts ./scripts
RUN npm run build:release

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production \
    PORT=8080 \
    TRACKER_FILE=/app/assets/tracker.js \
    ADMIN_UI_DIR=/app/assets/admin
WORKDIR /app
# Only what the bundle leaves external (the Firestore client), installed exactly as the lock file says.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/ingest/package.json packages/ingest/
COPY packages/senders/package.json packages/senders/
COPY packages/server/package.json packages/server/
COPY packages/store/package.json packages/store/
COPY packages/tracker/package.json packages/tracker/
COPY packages/admin-ui/package.json packages/admin-ui/
RUN npm ci --omit=dev --workspace=@datahash/server --ignore-scripts && npm cache clean --force
COPY --from=build /src/dist/release/ ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
