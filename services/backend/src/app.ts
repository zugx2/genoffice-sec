/**
 * App factory — the composition root.
 *
 * `buildApp` wires the Fastify instance with its plugins but does NOT
 * listen: unit tests drive it through `app.inject()`, the integration
 * script and `server.ts` decide host/port. New phases add route plugins
 * here (`app.register(...)`), one module per resource.
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { BackendConfig } from './config.js'
import { verifyAuth } from './plugins/verify-auth.js'
import { whoamiRoutes } from './routes/whoami.js'

export interface BuildAppOptions {
  config: BackendConfig
  /**
   * Logger override for tests (pass `false` to silence). The default logger
   * redacts credential headers as defense-in-depth: fastify's built-in req
   * serializer omits headers today, but pino's standard serializer includes
   * them, and adopting it would otherwise leak bearer tokens into logs.
   */
  logger?: FastifyServerOptions['logger']
  /**
   * Unknown-`kid` refetch rate limit override (jose `cooldownDuration`),
   * in milliseconds. Production keeps the 30 s default; tests tighten it
   * to exercise rotation without waiting out the cooldown.
   */
  jwksCooldownMs?: number
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options
  const app = Fastify({
    logger:
      options.logger ??
      ({
        level: 'info',
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie'],
          censor: '[redacted]',
        },
      } satisfies FastifyServerOptions['logger']),
  })

  await app.register(verifyAuth, {
    issuer: config.issuer,
    audience: config.audience,
    jwksUrl: config.jwksUrl,
    clockSkewSeconds: config.clockSkewSeconds,
    jwksCooldownMs: options.jwksCooldownMs,
  })
  await app.register(whoamiRoutes)

  return app
}
