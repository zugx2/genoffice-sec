# GenOffice cloud backend (services/backend) — local/dev stack image.
# Build context: the REPO ROOT (see docker/keycloak/docker-compose.yml,
# `backend` profile; the root .dockerignore keeps it to this service plus
# tsconfig.base.json). Dev-only like the rest of that compose stack.
#
# The npm bundled with node:22 (10.x) crashes in arborist's loadPeerSet on
# vitest's peer set ("Cannot read properties of null (reading 'edgesOut')");
# npm 11 — the line the repo's lockfile is managed with — has the fix.
# Applied in both stages that resolve the manifest. Pinned to an exact
# version (11.19.0, the line the repo's lockfile is currently managed with)
# instead of ^11 so builds cannot drift onto a different npm behavior.

FROM node:22-alpine AS build
RUN npm install -g npm@11.19.0
# Keep the repo-relative layout so tsconfig.json's `../../tsconfig.base.json`
# extends resolves exactly as on the host.
WORKDIR /app/services/backend
COPY services/backend/package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.base.json /app/tsconfig.base.json
COPY services/backend/tsconfig.json services/backend/tsconfig.build.json ./
COPY services/backend/src ./src
RUN npm run build

# Runtime stage: production deps only, run as the non-root `node` user.
FROM node:22-alpine AS runtime
RUN npm install -g npm@11.19.0
ENV NODE_ENV=production
WORKDIR /app
COPY services/backend/package.json ./
# Lockfile rationale (carried over from the Task 8 review): both stages
# re-resolve dependencies from package.json alone — the repo-root workspace
# lockfile is deliberately outside the build context (see the root
# .dockerignore), and a per-service lockfile would fight that workspace
# lock. The image's fastify/jose versions can therefore drift within semver
# majors between builds; accepted for this dev-only compose stack.
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts
COPY --from=build /app/services/backend/dist ./dist
# The SQLite volume target (GENOFFICE_BACKEND_DB=/data/…), pre-owned by the
# unprivileged runtime user — a fresh named volume inherits the image dir's
# ownership on first mount, so the server can create its database file.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8000
CMD ["node", "dist/server.js"]
