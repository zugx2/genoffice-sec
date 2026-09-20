/**
 * `GET /whoami` — the identity probe.
 *
 * Requires auth (`authenticate` preHandler) and answers strictly from the
 * VERIFIED access-token payload: no introspection, no userinfo call, no
 * local user table. The shape mirrors what the app's session profile
 * expects (`sub` + roles).
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

/** Extract a string-array of Keycloak realm roles, when present and well-formed. */
function realmRoles(claims: { realm_access?: { roles?: unknown } }): string[] | undefined {
  const roles = claims.realm_access?.roles
  if (!Array.isArray(roles)) return undefined
  const strings = roles.filter((role): role is string => typeof role === 'string')
  return strings.length > 0 ? strings : undefined
}

export const whoamiRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  app.get('/whoami', { preHandler: [app.authenticate] }, async (request) => {
    const claims = request.auth?.payload
    // jose does not require `sub` to be present; Keycloak always sends it,
    // so a missing one means a malformed realm, not an auth failure.
    if (claims === undefined || typeof claims.sub !== 'string' || claims.sub === '') {
      throw new Error('verified token payload carries no usable "sub" claim')
    }
    const roles = realmRoles(claims)
    const scope = typeof claims.scope === 'string' && claims.scope !== '' ? claims.scope : undefined
    return {
      sub: claims.sub,
      ...(roles !== undefined ? { roles } : {}),
      ...(scope !== undefined ? { scope } : {}),
    }
  })
}
