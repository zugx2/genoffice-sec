/**
 * `sub` extraction for CRUD routes.
 *
 * The ONLY source of user identity is the verified access-token payload
 * (`request.auth`, set by `authenticate`). No route accepts a user/sub
 * parameter, and the store cannot be queried without one — ownership
 * scoping is structural, not an afterthought.
 */

import type { FastifyRequest } from 'fastify'

/**
 * The verified `sub`. Keycloak always sends it; a missing one means a
 * malformed realm, so it is a server error (500 via the global error
 * handler), never a silently empty scope.
 */
export function requireSub(request: FastifyRequest): string {
  const claims = request.auth?.payload
  if (claims === undefined || typeof claims.sub !== 'string' || claims.sub === '') {
    throw new Error('verified token payload carries no usable "sub" claim')
  }
  return claims.sub
}
