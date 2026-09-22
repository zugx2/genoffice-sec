# GenOffice cloud backend (`@genoffice/backend`)

Fastify service for the GenOffice cloud backend (`docs/cloud-backend-auth.md`,
Phase 4). It validates Keycloak-issued access tokens **locally** against the
realm JWKS — signature via a cached JWKS (`jose` `createRemoteJWKSet`, refetch
on unknown `kid`), plus `iss` / `aud` / `exp` checks with a small clock skew —
and never calls token introspection or userinfo. The `sub` claim is the user
identity everywhere; no local user table.

Current surface: `GET /whoami`, the projects/chats CRUD (Phase 6a), and the
document endpoints with version history (Phase 7a). Later phases register
additional route plugins in `src/app.ts`.

## Layout

| Path                            | What it is                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `src/config.ts`                 | Typed env config, validated fail-fast at startup                             |
| `src/plugins/verify-auth.ts`    | `verifyAuth` fastify plugin: `authenticate` guard + `request.auth` payload   |
| `src/plugins/error-handler.ts`  | Global error handler: uniform `{error:{code,message}}` envelope              |
| `src/plugins/storage.ts`        | Storage plugin: SQLite store + byte store, decorates `app.store`/`app.files` |
| `src/storage/store.ts`          | Persistence: sub-scoped prepared statements over `node:sqlite`               |
| `src/storage/document-files.ts` | Document bytes on disk: `<dataDir>/<sub>/<docId>/<version>` + integrity      |
| `src/routes/whoami.ts`          | `GET /whoami` — identity from the verified token payload only                |
| `src/routes/projects.ts`        | `/projects` CRUD                                                             |
| `src/routes/chats.ts`           | `/projects/:projectId/chats` CRUD                                            |
| `src/routes/documents.ts`       | `/documents` CRUD + version history (multipart/raw uploads)                  |
| `src/app.ts`                    | App factory (`buildApp`) — composes plugins, no listen; testable via inject  |
| `src/server.ts`                 | Entry point: load config → build → listen → graceful shutdown                |
| `tests/`                        | vitest unit suite (real signed tokens against a local JWKS server)           |
| `scripts/integration.mts`       | Live-stack integration check (NOT part of plain `npm test`)                  |

## Run (dev)

Prerequisite: the local dev Keycloak is up (Phase 0 stack):

```bash
sg docker -c "docker compose -f docker/keycloak/docker-compose.yml up -d --wait"
```

Then, from the repo root:

```bash
npm install
npm run -w @genoffice/backend dev   # tsx watch, http://127.0.0.1:8000
```

Or build + run compiled output:

```bash
npm run -w @genoffice/backend build
npm run -w @genoffice/backend start
```

## Run (docker)

The backend ships as a profile-gated service in the Phase 0 compose file, so a
plain `up` stays Keycloak-only:

```bash
sg docker -c "docker compose -f docker/keycloak/docker-compose.yml --profile backend up -d --build"

# tear the whole stack down (wipes Keycloak state too)
sg docker -c "docker compose -f docker/keycloak/docker-compose.yml --profile backend down -v"
```

### Docker networking (why `GENOFFICE_BACKEND_JWKS_URL` exists)

Keycloak advertises — and signs tokens with — the issuer
`http://localhost:8080/realms/genoffice` (`KC_HOSTNAME` pins it). The `iss`
check must keep matching that value, but from inside the compose network
`localhost:8080` is not Keycloak. The compose service therefore overrides only
the JWKS fetch location to `http://keycloak:8080/...`, while
`GENOFFICE_BACKEND_ISSUER` stays the advertised issuer. Signature validation
and claim checking are unaffected; only the HTTP fetch target differs.

## API

Everything requires a valid bearer token; the verified token's `sub` is the
user identity. **No endpoint takes a user parameter** — ownership comes from
the token, and every query is `WHERE sub = ?` in the store, so cross-user
access is structurally impossible. Foreign ids answer 404 byte-identical to
missing ones (no existence leak). All error responses use the uniform
envelope `{error: {code, message}}` (401s additionally carry
`WWW-Authenticate: Bearer`).

### Resources

| Method   | Path                                 | Body / notes                                                | Success                   |
| -------- | ------------------------------------ | ----------------------------------------------------------- | ------------------------- |
| `GET`    | `/projects`                          | list (info records, no `files`; stable `(createdAt,id)`)    | `200 {projects:[…]}`      |
| `POST`   | `/projects`                          | `{name}` (non-blank, ≤ 200 chars)                           | `201` full record         |
| `GET`    | `/projects/:projectId`               | full record incl. `files`                                   | `200` / `404`             |
| `PUT`    | `/projects/:projectId`               | `{name, files}` — full-object replace; optional `If-Match`  | `200` / `404` / `409`     |
| `DELETE` | `/projects/:projectId`               | hard delete, cascades chats + messages; optional `If-Match` | `204` / `404` / `409`     |
| `GET`    | `/projects/:projectId/chats`         | chat list (id/createdAt/updatedAt/version/messageCount)     | `200 {chats:[…]}` / `404` |
| `POST`   | `/projects/:projectId/chats`         | no body — creates an empty chat                             | `201` / `404`             |
| `GET`    | `/projects/:projectId/chats/:chatId` | `?limit=N` → most recent N messages (ascending seq)         | `200` / `404`             |
| `PUT`    | `/projects/:projectId/chats/:chatId` | `{messages:[…]}` — full replace; optional `If-Match`        | `200` / `404` / `409`     |
| `DELETE` | `/projects/:projectId/chats/:chatId` | hard delete; optional `If-Match`                            | `204` / `404` / `409`     |

The model mirrors `packages/project-store` (the local filesystem store):
a project is `{name, files}`; a chat belongs to exactly one project and is
an ordered message list — `role` (`user`/`assistant`), `text`, optional
`ts` (client timestamp; server defaults it), `fileRef`, `tools`,
`attachments`, `scope`, exactly as the local `ChatMessage`. The server
assigns ids (UUIDs), `seq` (1..n by array position on every replace), and
`ts` defaults; `seq`/`version`/`createdAt`/`updatedAt`/`id` in a request
body are rejected (`additionalProperties: false`, no type coercion).

### Version semantics (Task 11's conflict policy)

Every mutable record carries `version` (monotonic integer, starts at 1) and
`updatedAt` (UTC ISO). Each successful mutation — `PUT` on a project or
chat — increments `version` and refreshes `updatedAt`. `POST` returns
`version: 1`; `DELETE` removes the record entirely.

`PUT` and `DELETE` take an optional `If-Match: <version>` header — the bare
integer `version` the client last saw (there is no ETag; the version is the
entity tag). The server compares it with the stored version **before**
mutating:

- header absent → last-writer-wins (Phase 6a behavior, unchanged);
- header equals the stored `version` → the mutation runs;
- header is older → `409 {error:{code:"version_conflict"}}` — another
  writer got there first; the stored record is untouched and the client
  re-reads and decides (the server never merges);
- anything but a bare non-negative integer (`"3"`, `*`, a list) → `400
validation_failed`.

A missing or foreign id still answers `404` regardless of `If-Match` — the
guard never turns absence into a conflict and never leaks existence. The
client-side policy built on this (remote `ProjectApi` in
`packages/project-store`, shell routing) is documented in
`docs/cloud-backend-auth.md` ("Phase 6 conflict & routing policy").

## Documents (Phase 7a)

Documents are files (docx/xlsx/pptx/pdf/md/html) with server-side version
history. Metadata (name, kind, size, sha256, version counter) lives in
SQLite; the bytes live on disk, laid out

```
$GENOFFICE_BACKEND_DATA_DIR/<urlencoded sub>/<documentId>/<version>
```

— never indexed by filename. The `sub` level makes byte isolation
structural (one user's tree is not addressable through another's), and the
`sub` directory name is URL-encoded, so even a `sub` carrying path
separators stays inside one directory. Files are written `0600` under
directories created `0700`, staged under a dot-file and renamed into place
**before** the SQLite rows commit, so a crash at any point can orphan a file
(inert) but never leaves a row without bytes.

### Endpoints

| Method   | Path                               | Body / notes                                                                                                      | Success                      |
| -------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `GET`    | `/documents`                       | list metadata (id, name, kind, size, updatedAt, currentVersion)                                                   | `200 {documents:[…]}`        |
| `POST`   | `/documents`                       | multipart (`name`, `kind` fields + one `file` part) — **primary**; or `application/octet-stream` + `?name=&kind=` | `201` record                 |
| `GET`    | `/documents/:id`                   | download current bytes (`ETag: version`)                                                                          | `200` bytes / `404`          |
| `PUT`    | `/documents/:id`                   | upload as above (metadata fields optional); optional `If-Match`                                                   | `200` record / `404` / `409` |
| `PUT`    | `/documents/:id?conflict=copy`     | stores the upload as a NEW document `<name> (conflict <UTC ISO>)`, fresh version chain                            | `201` / `404`                |
| `DELETE` | `/documents/:id`                   | hard delete rows + files; optional `If-Match`                                                                     | `204` / `404` / `409`        |
| `GET`    | `/documents/:id/versions`          | history: version, size, sha256, createdAt — newest first                                                          | `200 {versions:[…]}` / `404` |
| `GET`    | `/documents/:id/versions/:version` | download that version's bytes                                                                                     | `200` bytes / `404`          |

**Multipart is the primary upload shape** (multiple parts, streamed, no
total-size ambiguity); the raw octet-stream form with `name`/`kind` query
params is a documented fallback for trivial clients. Sending `name`/`kind`
as query params on a multipart request is a 400. Multipart bodies are held
to JSON-body strictness: only the `name`/`kind` fields, each at most once,
plus exactly one `file` part — anything else is a 400. Uploads stream
straight to their staging file, so a request is never buffered whole.

Version semantics: `POST` creates version 1; every `PUT` appends a version
row and bumps the document's monotonic counter, which is the `If-Match`
value and the download's `ETag` (deliberately the same bare integer the
guard accepts — not an RFC-quoted ETag). `PUT` may also update `name`/`kind`
by including them. Absent `If-Match` = last-writer-wins; stale = 409
`version_conflict` (the stored version is untouched); non-integer = 400.

**Conflict copies**: after a 409 the client re-uploads with
`?conflict=copy` and the server stores those bytes as a NEW document named
`<name> (conflict <UTC ISO>)` with its own version chain (201). The
original is never modified. The client-side conflict-copy mechanism (hybrid
mode) lands in Phase 7's adapters; this endpoint only makes it possible.

### Limits

| Limit                            | Value                                  | Behaviour                                                                                                              |
| -------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Max size of one uploaded version | 200 MiB                                | `413 payload_too_large`, enforced while streaming (nothing oversized is ever written) and up-front on `Content-Length` |
| Versions retained per document   | 50                                     | oldest pruned on insert (in the same SQLite transaction); a pruned version answers `404` like a missing one            |
| Document name                    | ≤ 255 chars, non-blank                 | `400 validation_failed`                                                                                                |
| `kind`                           | `docx` `xlsx` `pptx` `pdf` `md` `html` | `400 validation_failed`                                                                                                |

Integrity: the sha256 recorded with a version is computed from the bytes
actually written (a client-supplied hash is never trusted) and re-verified
on every download; a mismatch (disk corruption, tampering) is logged
server-side only and answered with the generic 500 `internal_error` — no
paths leak.

### Validation limits

Message field caps mirror the local store's truncation limits
(`packages/project-store`): `text` ≤ 32 000 chars, tool `input`/`output`
≤ 16 000, scope `text` ≤ 400. The local store truncates silently; the API
**rejects** with 400, so clients apply the same truncation before
uploading. JSON request bodies are limited to fastify's 1 MiB default;
document uploads use their own 200 MiB cap (see above).

## Configuration

All optional; validated at startup with a fail-fast error naming every bad
variable.

| Variable                               | Default                                  | Meaning                                                           |
| -------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `GENOFFICE_BACKEND_PORT`               | `8000` (the shell's `DEV_BACKEND_URL`)   | Listen port                                                       |
| `GENOFFICE_BACKEND_HOST`               | `127.0.0.1`                              | Bind address (compose sets `0.0.0.0`)                             |
| `GENOFFICE_BACKEND_ISSUER`             | `http://localhost:8080/realms/genoffice` | Required `iss` claim (strict equality, trailing-slash normalized) |
| `GENOFFICE_BACKEND_AUDIENCE`           | `genoffice-backend`                      | Required `aud` claim (realm's audience mapper adds it)            |
| `GENOFFICE_BACKEND_JWKS_URL`           | `{issuer}/protocol/openid-connect/certs` | JWKS fetch location (override for the Docker case)                |
| `GENOFFICE_BACKEND_CLOCK_SKEW_SECONDS` | `30`                                     | Leeway on `exp`/`nbf`                                             |
| `GENOFFICE_BACKEND_DB`                 | `:memory:`                               | SQLite path (`:memory:` or a file; parent dirs are created)       |
| `GENOFFICE_BACKEND_DATA_DIR`           | `<cwd>/data/documents`                   | Root of the document byte tree (created as needed)                |

The compose `backend` service sets `GENOFFICE_BACKEND_DB=/data/genoffice-backend.db`
and `GENOFFICE_BACKEND_DATA_DIR=/data/documents`
with the `backend-data` named volume mounted at `/data`, so data survives
container restarts (`docker compose down -v` wipes it — dev stack, by design).

Note: `docs/cloud-backend-auth.md` writes the JWKS path as
`protocol/openid-connection/certs`; the endpoint Keycloak actually serves is
`protocol/openid-connect/certs` (no "ion"), which is what the default uses and
what the live Phase 0 stack answers on.

## Trying it out

1. Start Keycloak (above) and the backend.
2. Mint an access token through the device flow — see
   `docker/keycloak/README.md` ("Smoke test") for the curl steps: request a
   device authorization, approve it as `testuser` / `testpass` on the
   verification page, poll the token endpoint.
3. Call the API:

````bash
# 401 without credentials (note the WWW-Authenticate: Bearer header)
curl -i http://localhost:8000/whoami

# 200 with the minted token
curl -s http://localhost:8000/whoami \
  -H "Authorization: Bearer $ACCESS_TOKEN"
# -> {"sub":"<user uuid>","roles":["default-roles-genoffice"],"scope":"openid profile email"}

# projects/chats CRUD with the same token
curl -s -X POST http://localhost:8000/projects \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"My project"}'
# -> 201 {"id":"<uuid>","name":"My project","files":[],"createdAt":…,"updatedAt":…,"version":1}

curl -s http://localhost:8000/projects -H "Authorization: Bearer $ACCESS_TOKEN"

curl -s -X PUT http://localhost:8000/projects/$PROJECT_ID/chats/$CHAT_ID \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","text":"hello"}]}'

# document upload (multipart, the primary shape) + byte-exact download
curl -s -X POST http://localhost:8000/documents \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F name=notes.md -F kind=md -F file=@notes.md
# -> 201 {"id":"<uuid>","name":"notes.md","kind":"md","size":…,"sha256":…,
#         "currentVersion":1,"createdAt":…,"updatedAt":…}

curl -s http://localhost:8000/documents/$DOCUMENT_ID \
  -H "Authorization: Bearer $ACCESS_TOKEN" -o downloaded.md
# response headers: etag: 1, content-type: application/octet-stream

# version-checked update (If-Match = the version last seen)
curl -s -X PUT http://localhost:8000/documents/$DOCUMENT_ID \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'If-Match: 1' \
  -F name=notes.md -F kind=md -F file=@notes.md

curl -s http://localhost:8000/documents/$DOCUMENT_ID/versions \
  -H "Authorization: Bearer $ACCESS_TOKEN"

## Tests

```bash
# unit suite (part of normal development, NOT of the repo-root npm test chain)
npm run -w @genoffice/backend test

# integration check against the live Phase 0 stack: boots Keycloak if it is
# down, mints real device-flow tokens as testuser AND a second provisioned
# user, starts the backend in-process on a throwaway file DB + document data
# dir, and asserts whoami + the full projects/chats CRUD + the document
# round-trips (upload/download, guarded update, conflict copy, history,
# If-Match delete) including cross-user isolation on both metadata and bytes
npm run -w @genoffice/backend test:integration
````

The unit suite signs real tokens with locally generated RSA keys and serves a
real JWKS endpoint over HTTP, so signature failures, claim rejections, and
`kid` rotation are exercised end-to-end (no mocked verify results).

## Security notes

- `iss` is checked by strict string equality against config; `aud` must
  contain `genoffice-backend`. The backend never inherits a client's trust
  decisions.
- Errors are stable JSON codes (`missing_token`, `invalid_token`,
  `validation_unavailable`, `not_found`, `validation_failed`,
  `bad_request`, `version_conflict`, `payload_too_large`,
  `unsupported_media_type`, `internal_error`) in the uniform
  `{error:{code,message}}`
  envelope; 401s carry `WWW-Authenticate: Bearer`. No token material is ever
  echoed in a response or a log line; 500s never leak internals.
- Ownership scoping is structural: `sub` comes only from the verified
  token, every store method takes it as its first parameter, and every SQL
  statement (including deletes) binds it. Foreign and missing resources
  answer the same 404. Document **bytes** are scoped the same way — the
  on-disk tree is keyed by (URL-encoded) `sub`, so no path through the API
  reaches another user's files, and a failed integrity check reports no
  paths to the client.
- All SQL goes through prepared statements with bound parameters — no user
  input is ever interpolated into a query string.
- Request logging redacts `authorization` and `cookie` headers (fastify's
  default req serializer omits headers; the redact list guards against
  adopting pino's standard serializer, which includes them).
- Asymmetric algorithms only (`RS256`/`PS256`/`ES256`); no symmetric secrets.

Everything here targets the local dev stack: plain HTTP, well-known dev
credentials, no persistence. Do not reuse outside local development.
