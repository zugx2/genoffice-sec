/**
 * Server entry — loads config (fail-fast), builds the app, listens.
 * Graceful shutdown on SIGINT/SIGTERM so in-flight requests drain.
 */

import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig(process.env)
const app = await buildApp({ config })

await app.listen({ port: config.port, host: config.host })

app.log.info(
  {
    port: config.port,
    host: config.host,
    issuer: config.issuer,
    audience: config.audience,
    jwksUrl: config.jwksUrl,
    clockSkewSeconds: config.clockSkewSeconds,
  },
  'genoffice backend listening',
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down')
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'error during shutdown')
        process.exit(1)
      })
  })
}
