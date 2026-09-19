# Cloud backend & OIDC authentication design

Status: draft design (decision points in the last section carry recommended
defaults; tasks below can start against the defaults and be adjusted when a
decision is flipped).

Date: 2026-09-19
Scope: user authentication via OIDC / Keycloak, an authenticated cloud
backend service, and the client integration to reach it from the Electron
shell.

## Goals

- Users log in with their Keycloak identity from the desktop app.
- The renderer never handles tokens; all auth and backend traffic runs in the
  main process (matches the existing CSP posture — renderers are locked to
  `'self'` and cannot call external origins).
- Tokens persist encrypted so a session survives app restarts.
- A cloud backend service accepts Keycloak-issued JWTs and exposes per-user
  data (profile round-trip first, projects/chats next, documents last).
- Everything is phased so each phase ships value on its own.

## Non-goals (for now)

- Replacing the Genspark device-code login used for AI providers (see
  decision point 1).
- Making the cloud the source of truth for documents (decision point 2).
- Multi-account / multi-realm switching in one running instance.

## Current architecture facts (anchors for implementers)

- One real Electron app: the shell (`apps/shell`). Per-app "main processes"
  are in-process TS modules bundled into the shell main by electron-vite
  (`apps/shell/src/main/tab-manager.ts:6-47`). Editor tabs are
  `WebContentsView`s; the home tab is the shell window's own webContents.
- IPC pattern: `registerXxxIpc()` functions called once at startup
  (`apps/shell/src/main/index.ts:4741-4758`), channels named
  `domain:kebab-action`, typed preload APIs via `contextBridge`
  (example: `apps/docs/src/preload/index.ts`).
- Existing account UX to reuse: device-code login in
  `packages/ai-search/src/genoffice-auth.ts` (`startGenofficeLogin`,
  `genofficeLogout`, `0600` credential file) driving the Account pane in
  `apps/shell/src/renderer/src/SettingsModal.tsx` over
  `home:account-login` / `home:account-login-event`
  (`apps/shell/src/shared/home-api.ts:377-439`).
- Storage: documents are plain files under `<Documents>/GenOffice`;
  projects/chats live in `packages/project-store` (deliberately
  Electron-free; renderer-facing `ProjectApi` interface at
  `packages/project-store/src/ipc.ts:67`).
- Networking: main process only, global `fetch` with proxy support
  (`packages/ai-provider/src/fetch.ts:57`, `installMainProcessProxy`).
  External URLs go through the `safeExternalUrl()` allowlist
  (`packages/electron-utils/src/safe-external-url.ts:21`).
- Build-time config injection: electron-builder `extraMetadata` + env vars
  (GA4 pattern in `apps/shell/electron-builder.cjs`).
- New workspace packages are consumed as raw TS source and bundled by the
  shell main automatically (see `packages/project-store/package.json`);
  only standalone per-app builds would need `externalizeDepsPlugin`
  exclude entries.
- `ee/` is reserved for enterprise (private-deployment) modules under a
  separate license.

## Authentication design

### Flow: Authorization Code + PKCE (S256) with loopback redirect

The desktop app is a public OAuth client (no secret on disk). Standard flow
per RFC 8252, system browser, loopback redirect:

```
┌──────────┐         ┌────────────────┐        ┌──────────┐        ┌──────────┐
│ Renderer │         │ Main process   │        │ System   │        │ Keycloak │
│ (button) │         │ (auth module)  │        │ browser  │        │          │
└────┬─────┘         └───────┬────────┘        └────┬─────┘        └────┬─────┘
     │ auth:login            │                      │                   │
     │──────────────────────▶│ bind 127.0.0.1:port │                   │
     │                       │ shell.openExternal   │                   │
     │                       │─────────────────────▶│ /auth?client_id…  │
     │                       │                      │ &code_challenge   │
     │                       │                      │──────────────────▶│
     │                       │                      │  user logs in     │
     │                       │                      │◀──────────────────│
     │                       │◀── GET /callback?code=… (local server) ──│
     │                       │ POST /token (code + verifier)            │
     │                       │─────────────────────────────────────────▶│
     │                       │◀── access_token, refresh_token, id_token │
     │                       │ encrypt via safeStorage → disk           │
     │◀── session changed ────│                                         │
```

Why this flow:

- The token exchange happens in Node (server-to-server), so Keycloak CORS
  configuration is irrelevant for the client — one classic stumbling block
  avoided.
- The system browser reuses the user's existing Keycloak SSO session, so the
  second login is one confirmation; it is also more phishing-resistant than
  a captive `BrowserWindow` (users can verify the real Keycloak URL).
- Loopback redirect gives an automatic return to the app — no code typing.

Fallback (deferred, not planned): the device authorization grant. Keycloak
supports it per realm + client, it needs no redirect URI or local server,
and `genoffice-auth.ts` is an in-repo precedent. Choose it only if the
loopback flow causes trouble in some locked-down environment.

### Token handling rules

| Token        | Lifetime (Keycloak default) | Storage                              | Who sees it            |
| ------------ | --------------------------- | ------------------------------------ | ---------------------- |
| access (JWT) | ~5 min                      | main-process memory only             | nobody (attached as `Authorization: Bearer` by the backend client) |
| refresh      | configurable, request `offline_access` | `safeStorage`-encrypted file in userData, `0600`-style discipline | nobody |
| id (JWT)     | ~5 min                      | memory; `id_token_hint` for logout   | nobody; decoded profile only |

- Renderer receives only `{ status, profile }` (name, email, roles, `sub`) —
  never any token, never any endpoint URL it could misuse.
- Proactive refresh timer at `exp − 30s` plus reactive refresh-once-on-401
  in the backend client.
- `safeStorage` requires a desktop keyring (libsecret on Linux). On WSL2 or
  headless Linux it reports unavailable: fall back to a plain `0600` file
  with a settings warning, or session-only login (no persisted refresh
  token). Implement the fallback from day one — dev machines hit it.

### Keycloak client configuration

- Realm `genoffice`, public client `genoffice-desktop`, **Standard flow +
  PKCE (S256)**; Direct access grants off.
- Valid redirect URIs: `http://127.0.0.1:*` (loopback wildcard port; use
  `127.0.0.1`, not `localhost`, to avoid name-resolution surprises).
- Web origins: none needed (token exchange is server-to-server).
- Scopes requested: `openid profile email offline_access`.
- **Audience gotcha:** the access token `aud` defaults to the requesting
  client. Add the backend as an audience protocol mapper on the desktop
  client (or have the backend validate `azp`) or backend audience checks
  fail on day one.
- Logout: revoke the refresh token at the revocation endpoint, then open
  `end_session_endpoint` with `id_token_hint` (through the external-URL
  gate) so Keycloak clears its SSO cookie, then wipe the encrypted store
  and broadcast the session change.

## Cloud backend design

- Node + Fastify service. Code lives at `services/backend` (default; see
  decision point 3) with an Apache-2.0 license unless the enterprise
  decision moves it under `ee/`.
- Validates access tokens locally against the realm JWKS
  (`{issuer}/protocol/openid-connection/certs`): signature via cached JWKS
  (rotate on unknown `kid`), `iss`, `aud`, `exp` with small clock skew.
  No per-request network call; no token introspection.
- `sub` claim is the user identity everywhere (ownership, namespaces,
  audit). No local user table required for auth; an optional profile cache
  keyed by `sub`.
- Endpoints grow phase by phase: `GET /whoami` → projects/chats CRUD →
  document storage.

## Client integration map

### A. `packages/auth` (new, Electron-free core)

Raw-TS-source workspace package mirroring `project-store` (path-injected,
no Electron import):

- PKCE utils: verifier/challenge generation, `state`, `nonce`.
- Discovery client for `/.well-known/openid-configuration` with caching.
- Token set module: parse JWTs, expiry with clock skew, id-token claim
  checks (`iss`, `aud`, `nonce`, `sub`).
- Loopback callback server: bind `127.0.0.1` on a random free port,
  single-use, timeout, respond to browser with a plain "return to app"
  page.
- Auth orchestrator: `startLogin()` (builds URL, opens callback listener),
  `completeLogin(code)` (token exchange), `refresh()`, `logout()` (revoke +
  end-session URL construction). Pure logic — unit-testable with a mocked
  token endpoint.
- Token store interface with a file-backed implementation; `safeStorage`
  encryption added as an Electron-side decorator (keeps the core
  Electron-free).

### B. Shell main wiring (`apps/shell/src/main/index.ts`)

- `registerAuthIpc()` in the registration list (~`:4741`): channels
  `auth:login`, `auth:logout`, `auth:get-session`, push event
  `auth:session-changed`.
- Session manager: restore session at startup, single-flight login
  (concurrent `auth:login` calls reuse one attempt), proactive refresh
  timer, broadcast on any change.
- Extend `safeExternalUrl()` gating to permit the configured issuer (and
  its end-session endpoint) for browser opens.
- Config plumbing: `GENOFFICE_AUTH_ISSUER`, `GENOFFICE_AUTH_CLIENT_ID`,
  `GENOFFICE_BACKEND_URL` injected at build time via electron-builder
  `extraMetadata`; dev defaults point at `http://localhost:8080/realms/genoffice`
  (local docker Keycloak).

### C. Preload + renderer

- Shell preload exposes a typed `authApi`: `login()`, `logout()`,
  `getSession()`, `onSessionChanged(cb)` — profile only.
- `useSession()` hook in `packages/ui` for shared chrome.
- Settings Account pane (`SettingsModal.tsx`) drives login/logout with the
  existing progress-event pattern; shows profile + backend connection
  status.
- New UI strings go into the sharded i18n dictionaries (`zh.ts` + every
  sibling; keep `t` out of hook dependency arrays).

### D. Backend client (main process)

- Small authenticated-fetch wrapper: attach Bearer, on 401 refresh once and
  retry; built on the proxy-aware fetch stack so enterprise proxies keep
  working.

### E. Storage integration (phased)

1. Projects/chats: a remote `ProjectApi` implementation beside the local
   one in `packages/project-store`; the shell routes to it when a session
   is active. Offline behavior falls back to local (decision point 2
   refines this).
2. Documents: only after the mirror-vs-source-of-truth decision. Today's
   surfaces are path-coupled (`recent.json`, `starred.json`, home
   folder-tree with `realpathSync` dedupe, external-change detection), so
   this is the deepest change in the effort.

## Security checklist for each task

- Main-process networking only; no renderer-visible tokens or endpoint
  URLs.
- New external URLs always through `safeExternalUrl()` (browser opens) or
  the SSRF gate (`packages/electron-utils/src/safe-remote-url.ts`) for
  programmatic fetches.
- Credential files written with restrictive permissions; no secrets in the
  repo; endpoints injected at build time.
- IPC payloads validated (zod, following the sheets precedent).
- Update `SECURITY.md` when the network surface changes.

## Phases & task breakdown

Each task is meant to be independently pick-up-able. Phases deliver value
standalone; later phases build on earlier ones.

### Phase 0 — local dev environment

- [ ] `docker/keycloak/docker-compose.yml`: Keycloak (pin major version) +
      realm import: realm `genoffice`, public client `genoffice-desktop`
      (standard flow + PKCE, redirect `http://127.0.0.1:*`), audience
      mapper for the backend, one test user.
- [ ] `docker/keycloak/README.md`: run instructions + the client/realm
      settings the export encodes (so it can be recreated by hand against
      an existing Keycloak).

### Phase 1 — `packages/auth` core (pure Node, no Electron)

- [ ] Package scaffold mirroring `project-store` (raw TS source exports,
      npm-workspaces wiring, vitest).
- [ ] PKCE utils (verifier/challenge S256, `state`, `nonce`) + unit tests.
- [ ] Discovery client (well-known fetch, caching, error surface) + tests.
- [ ] JWT/token-set module (parse, expiry + skew, id-token claim checks)
      + tests (include a `aud`-mismatch fixture).
- [ ] Loopback callback server (random port, single use, timeout, safe
      response page) + tests.
- [ ] Token store interface + file-backed store (`0600`) + tests.
- [ ] Auth orchestrator (`startLogin`/`completeLogin`/`refresh`/`logout`)
      against a mocked token endpoint + tests (happy path, expiry refresh,
      refresh-token rotation, revoke-on-logout).

### Phase 2 — shell main integration

- [ ] Config module: build-time `extraMetadata` env → typed
      `authConfig`, dev defaults to local Keycloak.
- [ ] `safeExternalUrl()` extension for the issuer.
- [ ] Session manager (restore at startup, single-flight login, refresh
      timer, change events).
- [ ] `registerAuthIpc()` (`auth:login|logout|get-session`,
      `auth:session-changed`) with zod-validated payloads.
- [ ] Electron-side `safeStorage` token-store decorator with the WSL2 /
      headless fallback.
- [ ] Manual smoke test: login against local Keycloak, restart app, still
      logged in, logout clears everything.

### Phase 3 — renderer UI

- [ ] Shell preload `authApi` + shared types.
- [ ] `useSession()` hook in `packages/ui`.
- [ ] Settings Account pane: login/logout buttons, progress, profile
      display, encrypted-storage warning when `safeStorage` is
      unavailable.
- [ ] i18n strings for all of the above (`zh.ts` + all sibling shards).

### Phase 4 — backend service skeleton

- [ ] `services/backend` scaffold (Fastify, TS, vitest, docker-compose
      service).
- [ ] JWKS validation plugin (cache, `kid` rotation, `iss`/`aud`/`exp`
      checks) + unit tests.
- [ ] `GET /whoami` returning the decoded identity.
- [ ] Integration test running against the Phase 0 Keycloak container.
- [ ] README: run, config (issuer, audience, port).

### Phase 5 — backend client in the app

- [ ] Authenticated fetch wrapper (Bearer attach, refresh-once-on-401,
      proxy-aware) + tests.
- [ ] Account pane shows backend connection status via `whoami` probe.
- [ ] Build-time backend URL plumbing.

### Phase 6 — projects/chats on the backend

- [ ] Backend: projects/chats CRUD endpoints scoped by `sub`.
- [ ] Remote `ProjectApi` implementation in `packages/project-store`.
- [ ] Shell routing: remote when session active, local fallback offline;
      conflict/merge policy documented and tested.

### Phase 7 — documents (blocked on decision point 2)

- [ ] Design note: mirror vs source of truth for document files.
- [ ] Implementation tasks derived from that note.

## Open decision points

Defaults below are what the tasks assume; flipping one updates the tasks
listed under the affected phase.

1. **Relationship to the Genspark account login.** Default: coexist —
   Keycloak is the user identity for the cloud backend; the Genspark
   device login stays the AI-provider credential. `home:cloud-projects`
   keeps meaning Genspark projects until a later unification.
2. **Cloud as source of truth vs sync/mirror for user data.** Default for
   projects/chats (Phase 6): cloud is the source of truth when online,
   local fallback offline. Documents (Phase 7) undecided — blocked task.
3. **Backend code location & license.** Default: `services/backend`,
   Apache-2.0, in-repo. Alternative: `ee/` with its separate license if
   this ships as an enterprise/private-deployment feature.
4. **Deployment shape.** Default: issuer + backend URLs are build-time
   configured per distribution (central SaaS first). Alternative for
   enterprise: first-run configuration UI pointing at a self-hosted
   Keycloak + backend pair.
