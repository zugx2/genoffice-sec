# GenOffice cloud backend (`@genoffice/backend`)

Fastify service for the GenOffice cloud backend (`docs/cloud-backend-auth.md`,
Phase 4). It validates Keycloak-issued access tokens **locally** against the
realm JWKS — signature via a cached JWKS (`jose` `createRemoteJWKSet`, refetch
on unknown `kid`), plus `iss` / `aud` / `exp` checks with a small clock skew —
and never calls token introspection or userinfo. The `sub` claim is the user
identity everywhere; no local user table.

Current surface: `GET /whoami`. Later phases (projects, chats, documents)
register additional route plugins in `src/app.ts`.

## Layout

| Path                         | What it is                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- |
| `src/config.ts`              | Typed env config, validated fail-fast at startup                            |
| `src/plugins/verify-auth.ts` | `verifyAuth` fastify plugin: `authenticate` guard + `request.auth` payload  |
| `src/routes/whoami.ts`       | `GET /whoami` — identity from the verified token payload only               |
| `src/app.ts`                 | App factory (`buildApp`) — composes plugins, no listen; testable via inject |
| `src/server.ts`              | Entry point: load config → build → listen → graceful shutdown               |
| `tests/`                     | vitest unit suite (real signed tokens against a local JWKS server)          |
| `scripts/integration.mts`    | Live-stack integration check (NOT part of plain `npm test`)                 |

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

```bash
# 401 without credentials (note the WWW-Authenticate: Bearer header)
curl -i http://localhost:8000/whoami

# 200 with the minted token
curl -s http://localhost:8000/whoami \
  -H "Authorization: Bearer $ACCESS_TOKEN"
# -> {"sub":"<user uuid>","roles":["default-roles-genoffice"],"scope":"openid profile email"}
```

## Tests

```bash
# unit suite (part of normal development, NOT of the repo-root npm test chain)
npm run -w @genoffice/backend test

# integration check against the live Phase 0 stack: boots Keycloak if it is
# down, mints a real device-flow token as testuser, starts the backend
# in-process, and asserts GET /whoami returns that identity
npm run -w @genoffice/backend test:integration
```

The unit suite signs real tokens with locally generated RSA keys and serves a
real JWKS endpoint over HTTP, so signature failures, claim rejections, and
`kid` rotation are exercised end-to-end (no mocked verify results).

## Security notes

- `iss` is checked by strict string equality against config; `aud` must
  contain `genoffice-backend`. The backend never inherits a client's trust
  decisions.
- Errors are stable JSON codes (`missing_token`, `invalid_token`,
  `validation_unavailable`); 401s carry `WWW-Authenticate: Bearer`. No token
  material is ever echoed in a response or a log line.
- Request logging redacts `authorization` and `cookie` headers (fastify's
  default req serializer omits headers; the redact list guards against
  adopting pino's standard serializer, which includes them).
- Asymmetric algorithms only (`RS256`/`PS256`/`ES256`); no symmetric secrets.

Everything here targets the local dev stack: plain HTTP, well-known dev
credentials, no persistence. Do not reuse outside local development.
