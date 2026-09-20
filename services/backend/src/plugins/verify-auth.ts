/**
 * JWT validation plugin (`verifyAuth`).
 *
 * Validates Keycloak-issued access tokens locally: signature via a cached
 * JWKS (`jose`'s `createRemoteJWKSet` — caching and unknown-`kid` refetch
 * rotation included), plus `iss` (strict string equality against config),
 * `aud`, and `exp`/`nbf` with a small clock skew. No per-request network
 * call and no token introspection: verification is offline once the JWKS is
 * cached.
 *
 * Security notes carried over from the design review:
 * - The backend never inherits a client's trust decisions; it independently
 *   checks `iss`/`aud` against its own config.
 * - `device_code`/token material is never logged, and error responses carry
 *   stable JSON codes only — a 500 must not echo any part of the token.
 */

import fp from 'fastify-plugin'
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/** Keycloak access-token claims — loose beyond what `jwtVerify` guarantees. */
export interface AccessTokenClaims extends JWTPayload {
  /** Keycloak nests realm roles under `realm_access.roles` */
  realm_access?: {
    roles?: unknown
  }
}

/** Verified identity attached to a request by {@link verifyAuth}. */
export interface RequestAuth {
  /** The fully verified access-token payload (signature, iss, aud, exp all checked) */
  payload: AccessTokenClaims
}

export interface VerifyAuthOptions {
  /** Expected `iss` claim; compared with strict string equality */
  issuer: string
  /** Expected `aud` claim (e.g. `genoffice-backend`) */
  audience: string
  /** JWKS endpoint; may differ from the issuer host (Docker network case) */
  jwksUrl: string
  /** Clock skew tolerated on `exp`/`nbf`, in seconds (default 30) */
  clockSkewSeconds?: number
  /**
   * Rate limit for unknown-`kid` JWKS refetches, in milliseconds (jose's
   * `cooldownDuration`, default 30 000). An unknown `kid` seen within the
   * cooldown is rejected without refetching — real realm rotations publish
   * keys long before use, so the default is safe; tests tighten it.
   */
  jwksCooldownMs?: number
}

/**
 * Asymmetric algorithms accepted for token signatures. Keycloak realms
 * default to RS256; PS256 and ES256 cover the common admin overrides.
 * Symmetric (HS*) algorithms are deliberately excluded — the service holds
 * no shared secrets, and allowing them would invite algorithm confusion.
 */
const SUPPORTED_ALGORITHMS = ['RS256', 'PS256', 'ES256'] as const

/** Stable machine-readable error codes used in 401/500 bodies. */
export type AuthErrorCode = 'missing_token' | 'invalid_token' | 'validation_unavailable'

const WWW_AUTH_REALM = 'genoffice'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticate` after successful verification; null otherwise */
    auth: RequestAuth | null
  }

  interface FastifyInstance {
    /**
     * Route guard: verifies the Bearer token and populates `request.auth`.
     * Rejects with 401 (+ `WWW-Authenticate: Bearer`) on missing/invalid
     * tokens and 500 when the validation infrastructure (JWKS fetch) fails.
     */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

interface ErrorBody {
  error: { code: AuthErrorCode; message: string }
}

function authErrorBody(code: AuthErrorCode, message: string): ErrorBody {
  return { error: { code, message } }
}

/** True when the jose error means "this token is bad" (client's fault → 401). */
function isTokenRejection(err: unknown): boolean {
  return (
    err instanceof joseErrors.JWTExpired ||
    err instanceof joseErrors.JWTClaimValidationFailed || // iss / aud / nbf
    err instanceof joseErrors.JWTInvalid || // malformed JWT
    err instanceof joseErrors.JWSInvalid || // malformed JWS
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWKSNoMatchingKey || // unknown kid even after refetch
    err instanceof joseErrors.JWKSMultipleMatchingKeys ||
    err instanceof joseErrors.JOSENotSupported // e.g. disallowed alg
  )
}

function bearerToken(headerValue: string | string[] | undefined): string | undefined {
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (header === undefined) return undefined
  const match = /^\s*Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : undefined
}

/**
 * Register the `authenticate` guard and the `request.auth` decoration.
 * Wrapped in `fastify-plugin` so both cross encapsulation boundaries and
 * stay visible to route plugins registered after this one.
 */
export const verifyAuth = fp(
  async (app: FastifyInstance, options: VerifyAuthOptions): Promise<void> => {
    const { issuer, audience, jwksUrl } = options
    const clockTolerance = options.clockSkewSeconds ?? 30

    // Cached JWKS with rotation: an unknown `kid` triggers a refetch, gated
    // by jose's cooldown so a flood of unknown-kid tokens cannot turn into
    // a fetch storm.
    const JWKS = createRemoteJWKSet(
      new URL(jwksUrl),
      options.jwksCooldownMs !== undefined
        ? { cooldownDuration: options.jwksCooldownMs }
        : undefined,
    )

    app.decorateRequest('auth', null)

    app.decorate(
      'authenticate',
      async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const token = bearerToken(request.headers.authorization)
        if (token === undefined || token === '') {
          await reply
            .header('www-authenticate', `Bearer realm="${WWW_AUTH_REALM}"`)
            .code(401)
            .send(authErrorBody('missing_token', 'a bearer access token is required'))
          return
        }

        let payload: AccessTokenClaims
        try {
          ;({ payload } = await jwtVerify(token, JWKS, {
            issuer,
            audience,
            clockTolerance,
            algorithms: [...SUPPORTED_ALGORITHMS],
          }))
        } catch (err) {
          if (isTokenRejection(err)) {
            // The token itself is bad — say so without echoing any of it.
            await reply
              .header('www-authenticate', `Bearer realm="${WWW_AUTH_REALM}", error="invalid_token"`)
              .code(401)
              .send(authErrorBody('invalid_token', 'the bearer token is invalid or expired'))
            return
          }
          // Infrastructure failure (e.g. the JWKS endpoint is unreachable).
          // Logged server-side without token material; the client gets a
          // stable code and no internals.
          request.log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'token validation infrastructure failed',
          )
          await reply
            .code(500)
            .send(authErrorBody('validation_unavailable', 'token validation is unavailable'))
          return
        }

        request.auth = { payload }
      },
    )
  },
  { name: 'verifyAuth' },
)
