/**
 * auth type definitions.
 * OIDC discovery + device authorization grant (RFC 8628) value types,
 * plus the injectable transport/clock seams every module shares.
 */

/** Injectable HTTP transport (defaults to global fetch). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Injectable clock in epoch milliseconds (defaults to Date.now). */
export type Clock = () => number

/**
 * Parsed `/.well-known/openid-configuration` document.
 * `issuer` and the first two endpoints are validated on parse; the
 * remaining endpoints are optional per-provider capabilities.
 */
export interface DiscoveryDocument {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  /** RFC 8628 device authorization endpoint (present when the provider supports the device grant) */
  deviceAuthorizationEndpoint?: string
  /** RFC 7009 token revocation endpoint */
  revocationEndpoint?: string
  /** OIDC RP-initiated logout endpoint */
  endSessionEndpoint?: string
}

export interface DiscoveryClientOptions {
  /** Issuer URL, e.g. http://localhost:8080/realms/genoffice */
  issuer: string
  /** Cache TTL in milliseconds (default 5 minutes) */
  ttlMs?: number
  fetchFn?: FetchLike
  now?: Clock
}

/** Arguments of {@link requestDeviceAuthorization} — plain object, no ambient state. */
export interface DeviceAuthorizationRequest {
  /** device_authorization_endpoint from discovery */
  endpoint: string
  clientId: string
  /** Space-separated scope string, sent only when provided */
  scope?: string
  fetchFn?: FetchLike
}

/** Parsed RFC 8628 §3.2 device authorization response. */
export interface DeviceAuthorizationResponse {
  /** Secret kept strictly in memory; never logged or persisted */
  deviceCode: string
  /** Shown to the user verbatim (no reformatting) for comparison on the verification page */
  userCode: string
  verificationUri: string
  /** verification_uri + user_code, when the provider supplies it */
  verificationUriComplete?: string
  /** Seconds until device_code expires */
  expiresIn: number
  /** Minimum seconds between token polls (RFC 8628 default: 5) */
  interval: number
}

/** Injectable sleep used by the token poller (defaults to a real setTimeout promise). */
export type Sleep = (ms: number) => Promise<void>

/** OAuth 2.0 token endpoint success payload (RFC 6749 §5.1 plus the OIDC `id_token`). */
export interface TokenSet {
  accessToken: string
  tokenType: string
  /** Seconds until the access token expires, when the server sent an `expires_in` */
  expiresIn?: number
  /** Opaque refresh token (`offline_access`); passed through, never decoded */
  refreshToken?: string
  /** OIDC ID token (JWT); decoded for the profile, reused as `id_token_hint` on logout */
  idToken?: string
  /** Granted scope, when the server echoes it */
  scope?: string
}

/** Arguments of {@link startDeviceTokenPoll} — plain object, no ambient state. */
export interface DeviceTokenPollOptions {
  /** token_endpoint from discovery */
  endpoint: string
  clientId: string
  /** device_code from the device authorization response — memory only, never logged or persisted */
  deviceCode: string
  /** Seconds the device_code stays redeemable (DeviceAuthorizationResponse.expiresIn) */
  expiresIn: number
  /** Minimum seconds between polls (DeviceAuthorizationResponse.interval; RFC default 5) */
  interval?: number
  fetchFn?: FetchLike
  now?: Clock
  sleep?: Sleep
}

/**
 * Handle for an in-flight device token poll. `promise` resolves with the
 * token set on success and rejects with a `TokenPollError` on every
 * terminal condition; `cancel()` stops polling and rejects the promise
 * with a `cancelled` error (idempotent; safe after the promise settled).
 */
export interface DeviceTokenPollHandle {
  promise: Promise<TokenSet>
  cancel: () => void
}

/** Decoded JWT: base64url segments parsed to JSON objects; signature not verified here. */
export interface DecodedJwt {
  header: Record<string, unknown>
  payload: Record<string, unknown>
}

/** ID-token claims after validation: `sub` guaranteed, profile fields left loose. */
export interface IdTokenClaims {
  sub: string
  [claim: string]: unknown
}

/** Expected id-token values {@link validateIdToken} checks against. */
export interface IdTokenValidationOptions {
  /** Configured issuer (discovery `issuer`) */
  issuer: string
  /** Configured audience, i.e. the OAuth client_id */
  audience: string
}

/** Options of {@link isJwtExpired}. */
export interface JwtExpiryOptions {
  now?: Clock
  /** Clock-skew window in milliseconds applied *before* `exp` (default 30 s) */
  skewMs?: number
}

// ────────────────────────────────────────────────────────────
// Token store
// ────────────────────────────────────────────────────────────

/**
 * Profile snapshot taken from the id-token claims. `sub` is the stable user
 * identity; the rest are the display fields the UI shows — nothing else
 * leaks out of the token.
 */
export interface UserProfile {
  sub: string
  name?: string
  email?: string
  preferredUsername?: string
}

/**
 * The persisted credential set: refresh token + id token + profile snapshot
 * + metadata. Access tokens are deliberately NOT part of it — they stay in
 * main-process memory only.
 */
export interface StoredTokenSet {
  /** Opaque refresh token (`offline_access`); the only re-login credential */
  refreshToken: string
  /** Latest id token; reused as `id_token_hint` on logout after a restart */
  idToken: string
  profile: UserProfile
  /** Epoch milliseconds when the token set was obtained */
  obtainedAt: number
  /** Issuer the id-token claims were validated against */
  issuer: string
}

/**
 * Persistence seam for {@link StoredTokenSet}. The core ships a plain
 * file-backed implementation; the Electron side wraps it in a `safeStorage`
 * encrypting decorator (same interface, so the core stays Electron-free).
 */
export interface TokenStore {
  load(): Promise<StoredTokenSet | null>
  save(tokenSet: StoredTokenSet): Promise<void>
  clear(): Promise<void>
}

/** Options of {@link FileTokenStore}. */
export interface FileTokenStoreOptions {
  /** File path the store reads and writes (created with mode 0600) */
  path: string
}

// ────────────────────────────────────────────────────────────
// Auth orchestrator
// ────────────────────────────────────────────────────────────

/** Provider configuration for {@link AuthOrchestrator}. */
export interface AuthConfig {
  /** Issuer URL, e.g. http://localhost:8080/realms/genoffice */
  issuer: string
  /** OAuth client_id (a public client with the device grant enabled) */
  clientId: string
  /** Expected id-token `aud`; defaults to {@link AuthConfig.clientId} */
  audience?: string
  /** Space-separated scope (default `openid profile email offline_access`) */
  scope?: string
}

/** Constructor options of {@link AuthOrchestrator}. */
export interface AuthOrchestratorOptions {
  config: AuthConfig
  store: TokenStore
  fetchFn?: FetchLike
  now?: Clock
  sleep?: Sleep
}

/**
 * The live in-memory session. Access and id tokens live here only — they are
 * never persisted; the refresh token is held internally and goes through the
 * {@link TokenStore} exclusively.
 */
export interface AuthSession {
  accessToken: string
  /** Current id token; reused as `id_token_hint` on logout */
  idToken: string
  profile: UserProfile
  /** Epoch milliseconds when this token set was obtained */
  obtainedAt: number
  /** Epoch milliseconds when the access token expires, when `expires_in` was sent */
  accessTokenExpiresAt?: number
}

/** What `startLogin()` resolves with once the device code is available. */
export interface LoginHandle {
  /** Shown to the user verbatim — the anti-phishing comparison step */
  userCode: string
  /** verification_uri; main-process data (open in the system browser) */
  verificationUri: string
  /** verification_uri + user_code, when the provider supplies it */
  verificationUriComplete?: string
  /** Epoch milliseconds when the device_code expires */
  expiresAt: number
  /** Resolves with the session once the user approves; rejects typed on every terminal condition */
  tokens: Promise<AuthSession>
  /** Cancels this login attempt (delegates to `cancelLogin()`) */
  cancel(): void
}

/** What `logout()` resolves with. */
export interface LogoutResult {
  /**
   * `end_session_endpoint` + `id_token_hint`, constructed for the caller to
   * open (core never opens anything). `undefined` when discovery offers no
   * end-session endpoint or no id token is available for the hint.
   */
  endSessionUrl?: string
}
