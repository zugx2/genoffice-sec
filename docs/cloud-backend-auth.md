# Cloud backend & OIDC authentication design

Status: draft design (decision points in the last section carry recommended
defaults; tasks below can start against the defaults and be adjusted when a
decision is flipped).

Date: 2026-09-19 (flow decision updated 2026-09-19: device grant chosen
over authorization-code + PKCE loopback — see "Alternative considered";
document storage modes decided 2026-09-19 — see "Document storage modes")
Scope: user authentication via OIDC / Keycloak, an authenticated cloud
backend service, and the client integration to reach it from the Electron
shell.

## Goals

- Users log in with their Keycloak identity from the desktop app.
- The renderer never handles tokens; all auth and backend traffic runs in the
  main process (matches the existing CSP posture — renderers are locked to
  `'self'` and cannot call external origins).
- Tokens persist encrypted so a session survives app restarts.
- Documents support three user-selectable storage modes — local-only
  (default, unchanged behavior), remote-only (files exist only on the
  server), and hybrid (local file + mirrored server copy).
- No redirect URIs (including `http://127.0.0.1:*` loopback) registered in
  Keycloak, so deployments whose security baselines forbid http/loopback
  redirects work as-is.
- A cloud backend service accepts Keycloak-issued JWTs and exposes per-user
  data (profile round-trip first, projects/chats next, documents last).
- Everything is phased so each phase ships value on its own.

## Non-goals (for now)

- Replacing the Genspark device-code login used for AI providers (see
  decision point 1).
- Background two-way folder sync (Dropbox-style daemon). Hybrid mode is
  upload-on-save mirroring plus open-from-cloud, not continuous sync.
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
- Existing account UX **and device-flow precedent** to reuse:
  `packages/ai-search/src/genoffice-auth.ts` implements a device-code login
  today (`startGenofficeLogin`, `genofficeLogout`, `0600` credential file)
  and drives the Account pane in
  `apps/shell/src/renderer/src/SettingsModal.tsx` over
  `home:account-login` / `home:account-login-event`
  (`apps/shell/src/shared/home-api.ts:377-439`). Our login UX copies this
  shape.
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

### Flow: Device Authorization Grant (RFC 8628)

The desktop app is a public OAuth client (no secret on disk). Login uses
the device authorization grant — the same pattern as the in-repo Genspark
login, and the flow that requires **no redirect URI of any kind**:

```
┌──────────┐         ┌────────────────┐        ┌──────────┐        ┌──────────┐
│ Renderer │         │ Main process   │        │ System   │        │ Keycloak │
│ (button) │         │ (auth module)  │        │ browser  │        │          │
└────┬─────┘         └───────┬────────┘        └────┬─────┘        └────┬─────┘
     │ auth:login            │ POST /auth/device                      │
     │──────────────────────▶│────────────────────────────────────────▶│
     │                       │◀─ device_code, user_code,               │
     │                       │   verification_uri(_complete), interval │
     │◀── login-event ────────│                                         │
     │  (show user code)     │ shell.openExternal(verification_uri_complete)
     │                       │──────────────────────▶│ user confirms   │
     │                       │                       │ the code shown  │
     │                       │                       │────────────────▶│
     │                       │ POST /token (grant_type=…device_code,    │
     │                       │           poll every `interval` seconds)│
     │                       │────────────────────────────────────────▶│
     │                       │   … authorization_pending …             │
     │                       │◀─ access_token, refresh_token, id_token │
     │                       │ encrypt via safeStorage → disk          │
     │◀── session changed ────│                                         │
```

Step by step:

1. Main process POSTs `client_id` + scope to the discovery-provided
   `device_authorization_endpoint`.
2. Keycloak returns `device_code`, `user_code`,
   `verification_uri` / `verification_uri_complete` (pre-fills the code),
   `expires_in`, `interval`.
3. The renderer shows the `user_code`; the main process opens
   `verification_uri_complete` in the system browser (after checking its
   origin matches the configured issuer).
4. The user authenticates and confirms the code matches what the app is
   displaying (this comparison is the flow's phishing defense).
5. The main process polls the token endpoint with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code` every
   `interval` seconds, treating `authorization_pending` as keep-going,
   `slow_down` as "increase interval", and `access_denied` /
   `expired_token` as terminal.
6. On success: tokens as below; the browser tab can be closed; no callback
   of any kind ever reaches the app.

Why this flow:

- **No redirect URIs at all.** Nothing registered on the Keycloak client,
  so deployment security baselines that forbid `http://` and loopback
  redirects are satisfied without an audit argument.
- **No local HTTP listener during login.** The app only makes outbound
  requests; the attack surface is smaller even than a one-shot loopback
  server.
- **System browser authentication**: reuses the user's existing Keycloak
  SSO session, and the user can verify they are on the real Keycloak URL
  before typing anything.
- **Works when the browser is not on the same machine** as the app (SSH,
  RDP, remote dev boxes) — redirect-based flows cannot do this at all.
- **In-repo precedent**: `packages/ai-search/src/genoffice-auth.ts` ships a
  working device flow; the UX and progress-event plumbing are proven.
- **Accepted trade-off**: one extra confirmation step and a few seconds of
  polling versus an instant redirect. Chosen deliberately for policy
  compatibility.

Alternative considered (rejected for now): Authorization Code + PKCE
(RFC 7636) with a loopback redirect (RFC 8252, `http://127.0.0.1:*`). It is
the standard native-app flow with instant return, and it is safe under
PKCE — the authorization code is unredeemable without the in-process
verifier, which is why major IdPs (Entra, Google, etc.) run it for CLIs.
It was rejected because it requires registering a loopback http redirect
URI on the client, and the target deployments' policies disallow exactly
that. If a deployment ever wants it, add it behind an `authFlow:
'device' | 'pkce-loopback'` config — the session manager, token store, and
renderer surface below are flow-agnostic.

### Token handling rules

| Token        | Lifetime (Keycloak default) | Storage                              | Who sees it            |
| ------------ | --------------------------- | ------------------------------------ | ---------------------- |
| access (JWT) | ~5 min                      | main-process memory only             | nobody (attached as `Authorization: Bearer` by the backend client) |
| refresh      | configurable, request `offline_access` | `safeStorage`-encrypted file in userData, `0600`-style discipline | nobody |
| id (JWT)     | ~5 min                      | memory; `id_token_hint` for logout   | nobody; decoded profile only |
| device_code  | minutes (realm "Device Code Lifespan") | main-process memory only, **never logged, never persisted** — it is redeemable for tokens once approved | nobody |

- Renderer receives only `{ status, profile }` (name, email, roles, `sub`) —
  never any token, never any endpoint URL it could misuse.
- ID-token checks: `iss`, `aud`, `sub` (device grant carries no PKCE
  verifier or nonce; the user-code confirmation is the binding step).
- Proactive refresh timer at `exp − 30s` plus reactive refresh-once-on-401
  in the backend client.
- `safeStorage` requires a desktop keyring (libsecret on Linux). On WSL2 or
  headless Linux it reports unavailable: fall back to a plain `0600` file
  with a settings warning, or session-only login (no persisted refresh
  token). Implement the fallback from day one — dev machines hit it.

### Keycloak client configuration

- Realm `genoffice`: enable the realm-level **OAuth 2.0 Device Authorization
  Grant**; set "Device Code Lifespan" (default 600 s) and polling cadence
  to taste.
- Client `genoffice-desktop`: public client, device grant enabled;
  **Standard flow off, Direct access grants off**; no redirect URIs, no
  web origins.
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

## Document storage modes

A per-user setting, `storageMode`, selects where document files
(docx/xlsx/pptx/pdf/md/html) live:

| Mode | Local disk | Server | Availability |
| --- | --- | --- | --- |
| `local` (default) | authoritative | not used for documents | everyone; today's behavior unchanged |
| `remote` | ephemeral scratch only, wiped after use | authoritative — the only persistent copy | requires an active session |
| `hybrid` | authoritative on save | mirrored copy + version history | requires an active session |

Rules:

- `local` is the default and the only mode available without a session.
- `remote` requires an active session. Open = download into memory; save =
  upload. No persistent local copy is kept. Honest caveat: some engines,
  sidecars, and PDF paths still need real files to process, so ephemeral
  scratch files in a temp dir are unavoidable — they are deleted after
  use, and crash-recovery autosave targets the server (an ephemeral local
  buffer may hold unsaved work and is wiped on clean exit).
- `hybrid` keeps the local file as the working copy and mirrors every save
  to the server (upload-on-save); opening a cloud document downloads it to
  a local file. The server keeps version history; conflicts are detected
  on upload via version/ETag checks and resolved as conflict copies — no
  background sync daemon.
- Switching modes offers migration: local → hybrid/remote = bulk upload;
  remote → local/hybrid = bulk download.

What changes under `remote`/`hybrid` (the deep work — today's surfaces are
path-coupled):

- **Identity**: tabs, recents (`recent.json`), starred, and the home
  folder tree are keyed by absolute path today (including `realpathSync`
  dedupe in the tab manager). Remote documents get a server-assigned
  cloud document ID; recents/starred move to server-side metadata keyed
  by ID; the home tree gains a cloud view (virtual folders from server
  metadata) alongside the filesystem one.
- **Save/open routing**: per-editor handlers route through a
  `DocumentStore` abstraction (local / remote / hybrid adapters) instead
  of direct fs calls. Pilot in docs, then roll out to the other editors.
- **External-change detection** (local file watchers) is replaced in
  remote mode by server version checks on refresh.
- **Guards**: path-based write allowlists (`authorizeMcpDocWrite`,
  `docs:save-to`) gain ID-based equivalents.

Backend surface (Phase 7): per-`sub` isolated document endpoints —
`GET/POST /documents` (list/create), `GET/PUT/DELETE /documents/:id`
(download / version-checked update / delete),
`GET /documents/:id/versions`; multipart uploads for large files.

## Client integration map

### A. `packages/auth` (new, Electron-free core)

Raw-TS-source workspace package mirroring `project-store` (path-injected,
no Electron import):

- Discovery client for `/.well-known/openid-configuration` with caching
  (authorization, token, device-authorization, revocation, end-session
  endpoints).
- Device authorization module: request the device grant, parse
  `device_code` / `user_code` / `verification_uri(_complete)` /
  `expires_in` / `interval`.
- Token poller: poll the token endpoint with the device-grant type; handle
  `authorization_pending`, `slow_down` (lengthen interval), `access_denied`,
  `expired_token`; cancellable; stops at `expires_in`.
- Token set module: parse JWTs, expiry with clock skew, id-token claim
  checks (`iss`, `aud`, `sub`).
- Token store interface with a file-backed implementation; `safeStorage`
  encryption added as an Electron-side decorator (keeps the core
  Electron-free).
- Auth orchestrator: `startLogin()` (device request + returns codes +
  starts poll), `cancelLogin()`, `refresh()`, `logout()` (revoke +
  end-session URL construction). Pure logic — unit-testable with mocked
  endpoints.

### B. Shell main wiring (`apps/shell/src/main/index.ts`)

- `registerAuthIpc()` in the registration list (~`:4741`): channels
  `auth:login` (starts the device flow), `auth:cancel-login`,
  `auth:logout`, `auth:get-session`, push events `auth:login-event`
  (progress: user code, verification URI, waiting/success/failure — mirror
  the `home:account-login-event` shape) and `auth:session-changed`.
- Session manager: restore session at startup, single-flight login
  (concurrent `auth:login` calls reuse one attempt), proactive refresh
  timer, broadcast on any change.
- External URL gate: `safeExternalUrl()` must permit the issuer origin —
  used for `verification_uri_complete` during login and
  `end_session_endpoint` on logout. Validate both against the configured
  issuer before opening.
- Config plumbing: `GENOFFICE_AUTH_ISSUER`, `GENOFFICE_AUTH_CLIENT_ID`,
  `GENOFFICE_BACKEND_URL` injected at build time via electron-builder
  `extraMetadata`; dev defaults point at `http://localhost:8080/realms/genoffice`
  (local docker Keycloak).

### C. Preload + renderer

- Shell preload exposes a typed `authApi`: `login()`, `cancelLogin()`,
  `logout()`, `getSession()`, `onLoginEvent(cb)`, `onSessionChanged(cb)` —
  profile only, never tokens.
- `useSession()` hook in `packages/ui` for shared chrome.
- Settings Account pane (`SettingsModal.tsx`) drives login/logout: during
  login it shows the user code prominently (copyable), an "open
  verification page" action, an expiry countdown, and cancel — the same
  progress-event pattern the Genspark login uses. Also shows profile +
  backend connection status, and the encrypted-storage warning when
  `safeStorage` is unavailable.
- New UI strings go into the sharded i18n dictionaries (`zh.ts` + every
  sibling; keep `t` out of hook dependency arrays).

### D. Backend client (main process)

- Small authenticated-fetch wrapper: attach Bearer, on 401 refresh once and
  retry; built on the proxy-aware fetch stack so enterprise proxies keep
  working.

### E. Storage integration (phased)

1. Projects/chats: a remote `ProjectApi` implementation beside the local
   one in `packages/project-store`; the shell routes to it when a session
   is active. Offline behavior falls back to local.
2. Documents: three user-selectable storage modes — see "Document storage
   modes" — landing in Phase 7 behind a `DocumentStore` abstraction.

## Security checklist for each task

- Main-process networking only; no renderer-visible tokens or endpoint
  URLs.
- `device_code` stays in memory, is never logged, and polling stops on
  cancel or expiry.
- Display the `user_code` exactly as returned (no reformatting) — the user
  comparing it on Keycloak's page is the anti-phishing step; always offer
  `verification_uri_complete` but verify its origin against the configured
  issuer before opening.
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
      realm import: realm `genoffice` with Device Authorization Grant
      enabled, public client `genoffice-desktop` (device grant on,
      standard + direct-access off, no redirect URIs), audience mapper for
      the backend, one test user.
- [ ] `docker/keycloak/README.md`: run instructions + the client/realm
      settings the export encodes (so it can be recreated by hand against
      an existing Keycloak).

### Phase 1 — `packages/auth` core (pure Node, no Electron)

- [ ] Package scaffold mirroring `project-store` (raw TS source exports,
      npm-workspaces wiring, vitest).
- [ ] Discovery client (well-known fetch, caching, error surface) + tests.
- [ ] Device authorization request module (POST
      device_authorization_endpoint, parse response incl.
      `verification_uri_complete`, `expires_in`, `interval`) + tests.
- [ ] Token poller (device grant type; `authorization_pending` /
      `slow_down` / `access_denied` / `expired_token` handling; cancel;
      expiry stop) + tests.
- [ ] JWT/token-set module (parse, expiry + skew, id-token `iss`/`aud`/
      `sub` checks) + tests (include an `aud`-mismatch fixture).
- [ ] Token store interface + file-backed store (`0600`) + tests.
- [ ] Auth orchestrator (`startLogin`/`cancelLogin`/`refresh`/`logout`)
      against mocked endpoints + tests (happy path, pending → approved,
      user denial, code expiry, refresh, revoke-on-logout).

### Phase 2 — shell main integration

- [ ] Config module: build-time `extraMetadata` env → typed
      `authConfig`, dev defaults to local Keycloak.
- [ ] `safeExternalUrl()` extension permitting the issuer origin
      (verification + end-session URLs, validated against config).
- [ ] Session manager (restore at startup, single-flight login, refresh
      timer, change events).
- [ ] `registerAuthIpc()` (`auth:login`, `auth:cancel-login`,
      `auth:logout`, `auth:get-session`, `auth:login-event`,
      `auth:session-changed`) with zod-validated payloads.
- [ ] Electron-side `safeStorage` token-store decorator with the WSL2 /
      headless fallback.
- [ ] Manual smoke test: device login against local Keycloak, restart
      app, still logged in, logout clears everything.

### Phase 3 — renderer UI

- [ ] Shell preload `authApi` + shared types.
- [ ] `useSession()` hook in `packages/ui`.
- [ ] Settings Account pane: login flow with user-code display (copyable),
      "open verification page", expiry countdown, cancel, logout; profile
      display; encrypted-storage warning when `safeStorage` is
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

### Phase 7 — document storage modes

- [ ] Backend: document endpoints (list/create/download/version-checked
      update/delete + versions), per-`sub` isolation, multipart upload +
      integration tests.
- [ ] `DocumentStore` abstraction package + local adapter extracted from
      the per-editor save/open handlers (pilot: docs).
- [ ] Remote adapter: download-to-memory / upload-on-save, ephemeral
      scratch cleanup after use.
- [ ] Cloud document IDs: tab identity, server-side recents/starred,
      home cloud folder view.
- [ ] `storageMode` setting (`app-settings.json`) + Settings UI + guards
      (remote requires a session) + mode-switch migration (bulk
      upload/download).
- [ ] Per-mode autosave & crash recovery (remote: server autosave +
      ephemeral buffer wiped on clean exit).
- [ ] Hybrid conflict policy (version/ETag check → conflict copies) +
      tests.
- [ ] Roll `DocumentStore` out to sheets/slides/pdf/markdown/html.
- [ ] i18n strings + `SECURITY.md` update for the new network surface.

## Open decision points

Defaults below are what the tasks assume; flipping one updates the tasks
listed under the affected phase.

1. **Relationship to the Genspark account login.** Default: coexist —
   Keycloak is the user identity for the cloud backend; the Genspark
   device login stays the AI-provider credential. `home:cloud-projects`
   keeps meaning Genspark projects until a later unification.
2. **Document storage (resolved 2026-09-19).** Three user-selectable
   modes — `local` (default), `remote` (server-only), `hybrid` (local +
   mirrored) — per the "Document storage modes" section. Default to
   confirm during Phase 7: hybrid is upload-on-save mirroring with
   version/ETag conflict copies, not a background sync daemon.
3. **Backend code location & license.** Default: `services/backend`,
   Apache-2.0, in-repo. Alternative: `ee/` with its separate license if
   this ships as an enterprise/private-deployment feature.
4. **Deployment shape.** Default: issuer + backend URLs are build-time
   configured per distribution (central SaaS first). Alternative for
   enterprise: first-run configuration UI pointing at a self-hosted
   Keycloak + backend pair.
