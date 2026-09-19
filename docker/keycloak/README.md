# Local dev Keycloak

Dev-only Keycloak for the GenOffice cloud-backend / OIDC work
(`docs/cloud-backend-auth.md`, Phase 0). It publishes the `genoffice` realm on
host port **8080** — the dev anchor the desktop app and `packages/auth` point
at: `http://localhost:8080/realms/genoffice`.

Everything here is for local development: plain HTTP, well-known dev
credentials, no persistent state. Do not reuse any of it in production.

## Run / stop

```bash
# start (first boot takes ~15–30 s; realm imports automatically)
docker compose -f docker/keycloak/docker-compose.yml up -d --wait

# tear down and wipe all state (the realm re-imports on the next fresh boot)
docker compose -f docker/keycloak/docker-compose.yml down -v
```

Notes:

- Image is pinned to Keycloak major version 26 (`quay.io/keycloak/keycloak:26.2`).
- The realm is imported declaratively: `realm/genoffice-realm.json` is mounted
  read-only at `/opt/keycloak/data/import/` and `--import-realm` loads it
  (`start-dev` mode). Import is idempotent — if the realm already exists
  (e.g. after a plain restart, since the in-container H2 database survives
  restarts), Keycloak logs `Realm 'genoffice' already exists. Import skipped`
  and keeps the existing realm.
- There is no database volume on purpose: `down -v` returns you to exactly
  what the JSON declares. Any tweaks made in the admin console are lost.
- `KC_HOSTNAME: http://localhost:8080` pins the advertised issuer/endpoints so
  tokens always carry the issuer the app expects, regardless of which host
  name was used to reach the container.

## Endpoints and credentials (all dev-only)

| What | Value |
| --- | --- |
| Issuer | `http://localhost:8080/realms/genoffice` |
| Discovery | `http://localhost:8080/realms/genoffice/.well-known/openid-configuration` |
| Admin console | `http://localhost:8080/admin` (master realm) |
| Admin login | `admin` / `admin` (bootstrap admin, set via `KC_BOOTSTRAP_ADMIN_*`) |
| Test user (realm `genoffice`) | `testuser` / `testpass` — password is **non-temporary**; use it to approve device-flow logins |

## Smoke test

```bash
# discovery must advertise the device authorization endpoint
curl -s http://localhost:8080/realms/genoffice/.well-known/openid-configuration \
  | grep -o '"device_authorization_endpoint":"[^"]*"'
# -> "device_authorization_endpoint":"http://localhost:8080/realms/genoffice/protocol/openid-connect/auth/device"

# start a device authorization (returns user_code + verification_uri)
curl -s -X POST \
  -d 'client_id=genoffice-desktop&scope=openid profile email offline_access' \
  http://localhost:8080/realms/genoffice/protocol/openid-connect/auth/device

# polling before approval returns authorization_pending (expected)
curl -s -X POST \
  -d 'client_id=genoffice-desktop&device_code=<device_code from above>&grant_type=urn:ietf:params:oauth:grant-type:device_code' \
  http://localhost:8080/realms/genoffice/protocol/openid-connect/token
```

Approving a device login: open the `verification_uri` in a browser, sign in as
`testuser` / `testpass`, enter/confirm the `user_code`. The poll above then
returns tokens; the access token's `aud` contains `genoffice-backend`.

## What the realm JSON encodes

This is the complete list of settings in `realm/genoffice-realm.json`, so the
realm can be recreated by hand against an existing Keycloak (Admin console →
Realm settings / Clients / Users) if you cannot use the import.

### Realm `genoffice`

| Setting | Value | Where in the admin console |
| --- | --- | --- |
| Realm name | `genoffice` | Create realm |
| Enabled | on (default) | Realm settings → General |
| Display name | `GenOffice (local dev)` | Realm settings → General |
| Require SSL | `none` — dev-only; the stack is plain HTTP | Realm settings → General |
| Device Code Lifespan | `600` s (Keycloak default, set explicitly) | Realm settings → Tokens |
| Registration | disabled (default) | Realm settings → Login |
| Login with email | allowed | Realm settings → Login |

Note on "enable the device grant at the realm level": Keycloak has no
realm-wide on/off switch for the OAuth 2.0 Device Authorization Grant — it is
a **per-client capability** (see below) plus the realm-level Device Code
Lifespan above. Keycloak returns polling `interval: 5` (fixed) in the device
authorization response; there is no separate realm setting for it.

### Client `genoffice-desktop`

| Setting | Value | Where in the admin console |
| --- | --- | --- |
| Client ID | `genoffice-desktop` | Create client |
| Name / description | `GenOffice Desktop` / device-grant-only note | Client → Settings |
| Client type | OpenID Connect | Client → Settings |
| Authentication flow | Public (no client secret, no PKCE secret handling) — `publicClient: true` | Client → Settings |
| Standard flow | **off** | Client → Settings → Capability config |
| Direct access grants | **off** | Client → Settings → Capability config |
| Implicit flow | off (default, explicit) | Client → Settings → Capability config |
| Service accounts | off (default, explicit) | Client → Settings → Capability config |
| OAuth 2.0 Device Authorization Grant | **on** — client attribute `oauth2.device.authorization.grant.enabled: "true"` | Client → Settings → Capability config |
| Valid redirect URIs | **empty** | Client → Settings |
| Web origins | **empty** | Client → Settings |

Scopes: the desktop client requests `openid profile email offline_access`.
`profile` and `email` are realm-default client scopes assigned to every
client; `offline_access` is an *optional* client scope the client requests
explicitly — the user then grants it during device-flow approval (Keycloak
asks "Grant Access to GenOffice Desktop" listing "Offline Access"). Realm
default roles / default client scopes are otherwise left untouched (Keycloak
defaults), which is what makes the refresh-token request work.

### Protocol mapper on `genoffice-desktop`

| Setting | Value |
| --- | --- |
| Name | `genoffice-backend-audience` |
| Type | Audience (protocol mapper `oidc-audience-mapper`) |
| Included Client Audience | `genoffice-backend` |
| Add to access token | yes |
| Add to ID token | no |

Why: the access token `aud` would otherwise default to the requesting client
(`genoffice-desktop`). The backend client `genoffice-backend` does not exist
until Phase 4 — the mapper is a hardcoded audience string and does not require
the client to exist — and it must validate `aud` from day one.

### User `testuser`

| Setting | Value |
| --- | --- |
| Username | `testuser` |
| Password | `testpass` — **non-temporary** (`temporary: false`), so dev logins never hit the required "update password" action |
| Email | `testuser@example.com` (verified) — so the `email` scope returns a claim |
| Name | Test / User — so the `profile` scope returns claims |
| Enabled | yes |
| Realm roles | `default-roles-genoffice` (the realm's default composite → `offline_access`, `uma_authorization`) |

The explicit `realmRoles: ["default-roles-genoffice"]` matters: realm import
does **not** auto-assign the default role composite to users declared in the
import JSON (unlike users created via the admin console/API). Without it,
`testuser` has no `offline_access` role and the token endpoint answers
`not_allowed: Offline tokens not allowed for the user or client` even though
the scope was consented.
