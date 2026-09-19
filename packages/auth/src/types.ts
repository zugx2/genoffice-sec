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
