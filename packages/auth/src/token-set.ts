/**
 * Token endpoint payload + JWT handling.
 *
 * `parseTokenResponse` maps the OAuth token endpoint success body to a
 * {@link TokenSet}; `decodeJwt` / `isJwtExpired` / `validateIdToken` work on
 * the JWTs inside it. Signature verification is deliberately NOT here — the
 * cloud backend validates via JWKS; this client's binding defense is the
 * user-code confirmation plus TLS. Decoding is done by hand (base64url →
 * bytes → UTF-8 JSON), so the package picks up no JWT runtime dependency.
 */

import { TokenSetError } from './errors.js'
import type {
  Clock,
  DecodedJwt,
  IdTokenClaims,
  IdTokenValidationOptions,
  JwtExpiryOptions,
  TokenSet,
} from './types.js'

/** Default clock-skew window: 30 s, matching the refresh-at-exp−30s policy */
const DEFAULT_CLOCK_SKEW_MS = 30_000

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(doc: Record<string, unknown>, field: string): string {
  const value = doc[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TokenSetError(`Token response field "${field}" is missing or not a string`, {
      code: 'invalid_response',
    })
  }
  return value
}

function optionalString(doc: Record<string, unknown>, field: string): string | undefined {
  const value = doc[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalPositiveNumber(doc: Record<string, unknown>, field: string): number | undefined {
  const value = doc[field]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Parse a 2xx token endpoint body into a {@link TokenSet}. Throws
 * `TokenSetError` (code `invalid_response`) on non-JSON bodies and on a
 * missing/ill-typed `access_token` or `token_type`. The refresh token stays
 * opaque — it is stored, sent, and nothing else.
 */
export function parseTokenResponse(raw: string): TokenSet {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new TokenSetError('Token response is not valid JSON', { code: 'invalid_response', cause })
  }
  if (!isRecord(parsed)) {
    throw new TokenSetError('Token response is not a JSON object', { code: 'invalid_response' })
  }
  return {
    accessToken: requireString(parsed, 'access_token'),
    tokenType: requireString(parsed, 'token_type'),
    expiresIn: optionalPositiveNumber(parsed, 'expires_in'),
    refreshToken: optionalString(parsed, 'refresh_token'),
    idToken: optionalString(parsed, 'id_token'),
    scope: optionalString(parsed, 'scope'),
  }
}

/** Decode an unpadded base64url segment to bytes; throws on any foreign character. */
function base64UrlToBytes(segment: string): Uint8Array {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of segment) {
    const value = BASE64URL_ALPHABET.indexOf(char)
    if (value === -1) {
      throw new TokenSetError('JWT segment contains a non-base64url character', {
        code: 'invalid_jwt',
      })
    }
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

function decodeSegmentJson(segment: string, what: 'header' | 'payload'): Record<string, unknown> {
  let text: string
  let parsed: unknown
  try {
    text = new TextDecoder().decode(base64UrlToBytes(segment))
    parsed = JSON.parse(text)
  } catch (cause) {
    if (cause instanceof TokenSetError) throw cause
    throw new TokenSetError(`JWT ${what} does not decode to JSON`, { code: 'invalid_jwt', cause })
  }
  if (!isRecord(parsed)) {
    throw new TokenSetError(`JWT ${what} is not a JSON object`, { code: 'invalid_jwt' })
  }
  return parsed
}

/**
 * Split a JWT into its parsed header and payload (base64url decoded by
 * hand). The signature segment must be present but is not verified —
 * see the module doc. Throws `TokenSetError` (code `invalid_jwt`) on any
 * malformed input.
 */
export function decodeJwt(jwt: string): DecodedJwt {
  const segments = jwt.trim().split('.')
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new TokenSetError('JWT does not consist of three non-empty dot-separated segments', {
      code: 'invalid_jwt',
    })
  }
  return {
    header: decodeSegmentJson(segments[0], 'header'),
    payload: decodeSegmentJson(segments[1], 'payload'),
  }
}

/**
 * Staleness predicate for JWT credentials. Conservative skew: the token
 * counts as expired `skewMs` (default 30 s) *before* its `exp`, so callers
 * refresh early even when the local clock runs behind the issuer. Fails
 * safe — a payload without a usable numeric `exp` reports expired.
 */
export function isJwtExpired(jwt: string, options: JwtExpiryOptions = {}): boolean {
  const now: Clock = options.now ?? (() => Date.now())
  const skewMs = options.skewMs ?? DEFAULT_CLOCK_SKEW_MS
  const exp = decodeJwt(jwt).payload['exp']
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return true
  return now() >= exp * 1000 - skewMs
}

/**
 * Run the id-token claim checks (value checks only — signature validation
 * is the backend's job): `iss` must equal the configured issuer, `aud`
 * (string or string array per the JWT spec) must contain the configured
 * audience, and `sub` must be a non-empty string. Returns the decoded
 * claims for the profile surface; throws `TokenSetError` with code
 * `invalid_jwt` / `iss_mismatch` / `aud_mismatch` / `missing_sub`.
 */
export function validateIdToken(idToken: string, options: IdTokenValidationOptions): IdTokenClaims {
  const claims = decodeJwt(idToken).payload

  const iss = claims['iss']
  if (iss !== options.issuer) {
    throw new TokenSetError(
      `ID token issuer mismatch: expected "${options.issuer}", got "${String(iss)}"`,
      { code: 'iss_mismatch' },
    )
  }

  const aud = claims['aud']
  const audOk =
    typeof aud === 'string'
      ? aud === options.audience
      : Array.isArray(aud) && aud.some((entry) => entry === options.audience)
  if (!audOk) {
    const got = aud === undefined ? 'no aud claim' : JSON.stringify(aud)
    throw new TokenSetError(
      `ID token audience mismatch: expected "${options.audience}" in aud, got ${got}`,
      { code: 'aud_mismatch' },
    )
  }

  const sub = claims['sub']
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new TokenSetError('ID token is missing a non-empty sub claim', { code: 'missing_sub' })
  }

  return { ...claims, sub }
}
