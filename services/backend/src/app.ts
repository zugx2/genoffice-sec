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
import { errorHandlerPlugin } from './plugins/error-handler.js'
import { storagePlugin } from './plugins/storage.js'
import { verifyAuth } from './plugins/verify-auth.js'
import { chatRoutes } from './routes/chats.js'
import { projectRoutes } from './routes/projects.js'
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
    ajv: {
      // Strict validation for a sync API: no silent type coercion (a JSON
      // number where a string belongs is a client bug worth a 400, not a
      // stored "42") and no silent stripping of unknown properties —
      // `additionalProperties: false` schemas reject them instead. Query
      // strings therefore validate as strings (see the chat `limit` param).
      customOptions: { coerceTypes: false, removeAdditional: false },
    },
  })

  await app.register(errorHandlerPlugin)
  await app.register(verifyAuth, {
    issuer: config.issuer,
    audience: config.audience,
    jwksUrl: config.jwksUrl,
    clockSkewSeconds: config.clockSkewSeconds,
    jwksCooldownMs: options.jwksCooldownMs,
  })
  await app.register(storagePlugin, { dbPath: config.dbPath })
  await app.register(whoamiRoutes)
  await app.register(projectRoutes)
  await app.register(chatRoutes)

  return app
}
