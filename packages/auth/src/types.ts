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
