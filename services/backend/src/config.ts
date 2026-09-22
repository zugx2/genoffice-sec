import { join } from 'node:path'

/**
 * Typed, fail-fast service configuration.
 *
 * Everything comes from `GENOFFICE_BACKEND_*` environment variables with
 * dev-stack defaults (docs/cloud-backend-auth.md, Phase 4). Values are
 * validated once at startup and aggregated into a single `ConfigError`
 * listing every problem, so a misconfigured deploy fails loudly instead of
 * serving requests with the wrong trust anchors.
 */

/** Thrown by {@link loadConfig} when the environment is not usable. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export interface BackendConfig {
  /** Listen port (default 8000 — the shell's DEV_BACKEND_URL) */
  port: number
  /** Bind address (default 127.0.0.1; the Docker service sets 0.0.0.0) */
  host: string
  /** Expected `iss` claim — strict string equality after trailing-slash normalization */
  issuer: string
  /** Expected `aud` claim (default `genoffice-backend`) */
  audience: string
  /** Where the realm JWKS is fetched from (may differ from the issuer inside Docker networks) */
  jwksUrl: string
  /** Leeway applied to `exp`/`nbf` in seconds (default 30) */
  clockSkewSeconds: number
  /**
   * SQLite database path: `:memory:` (default; unit tests, throwaway runs)
   * or a file path (the compose service mounts a volume and points this at
   * it). Parent directories are created as needed.
   */
  dbPath: string
  /**
   * Root directory for document bytes (`<dataDir>/<sub>/<docId>/<version>`;
   * see storage/document-files.ts). Default `<cwd>/data/documents` for dev
   * runs; the compose service points it at the mounted volume.
   */
  dataDir: string
}

export const DEFAULT_PORT = 8000
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_ISSUER = 'http://localhost:8080/realms/genoffice'
export const DEFAULT_AUDIENCE = 'genoffice-backend'
export const DEFAULT_CLOCK_SKEW_SECONDS = 30
export const DEFAULT_DB_PATH = ':memory:'
/** Dev default: `<cwd>/data/documents` (a dev run's cwd is services/backend). */
export function defaultDataDir(): string {
  return join(process.cwd(), 'data', 'documents')
}

/** Strip trailing slashes so two issuers differing only in them compare equal (packages/auth convention). */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Keycloak's realm JWKS path. Note: docs/cloud-backend-auth.md writes
 * `{issuer}/protocol/openid-connection/certs`, but the endpoint Keycloak
 * actually serves is `protocol/openid-connect/certs` — this is the one the
 * live Phase 0 stack answers on.
 */
export function defaultJwksUrl(issuer: string): string {
  return `${stripTrailingSlashes(issuer)}/protocol/openid-connect/certs`
}

/** Parse an http(s) URL, or record why it is not one. */
function parseHttpUrl(raw: string, problems: string[], varName: string): URL | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    problems.push(`${varName} is not a valid URL: "${raw}"`)
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`${varName} must use http or https, got "${url.protocol}"`)
    return undefined
  }
  return url
}

function readString(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]
  // An empty variable is treated as unset (`VAR=` must not blank a default).
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read and validate the service configuration. Throws {@link ConfigError}
 * naming every offending variable when anything is invalid.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): BackendConfig {
  const problems: string[] = []

  const portRaw = readString(env, 'GENOFFICE_BACKEND_PORT')
  let port = DEFAULT_PORT
  if (portRaw !== undefined) {
    const parsed = Number(portRaw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      problems.push(`GENOFFICE_BACKEND_PORT must be an integer in [1, 65535], got "${portRaw}"`)
    } else {
      port = parsed
    }
  }

  const host = readString(env, 'GENOFFICE_BACKEND_HOST') ?? DEFAULT_HOST

  const issuerRaw = readString(env, 'GENOFFICE_BACKEND_ISSUER') ?? DEFAULT_ISSUER
  const issuerUrl = parseHttpUrl(issuerRaw, problems, 'GENOFFICE_BACKEND_ISSUER')
  const issuer = stripTrailingSlashes(issuerUrl?.href ?? issuerRaw)

  const audience = readString(env, 'GENOFFICE_BACKEND_AUDIENCE') ?? DEFAULT_AUDIENCE
  if (audience.includes('/')) {
    problems.push(`GENOFFICE_BACKEND_AUDIENCE must be a bare audience string, got "${audience}"`)
  }

  const jwksRaw = readString(env, 'GENOFFICE_BACKEND_JWKS_URL')
  let jwksUrl: string
  if (jwksRaw === undefined) {
    jwksUrl = defaultJwksUrl(issuer)
  } else {
    const jwksUrlParsed = parseHttpUrl(jwksRaw, problems, 'GENOFFICE_BACKEND_JWKS_URL')
    // The JWKS location may legitimately differ from the issuer (Docker
    // network), so no issuer cross-check here — only shape validation.
    jwksUrl = stripTrailingSlashes(jwksUrlParsed?.href ?? jwksRaw)
  }

  const skewRaw = readString(env, 'GENOFFICE_BACKEND_CLOCK_SKEW_SECONDS')
  let clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS
  if (skewRaw !== undefined) {
    const parsed = Number(skewRaw)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 600) {
      problems.push(
        `GENOFFICE_BACKEND_CLOCK_SKEW_SECONDS must be an integer in [0, 600], got "${skewRaw}"`,
      )
    } else {
      clockSkewSeconds = parsed
    }
  }

  const dbPath = readString(env, 'GENOFFICE_BACKEND_DB') ?? DEFAULT_DB_PATH
  const dataDir = readString(env, 'GENOFFICE_BACKEND_DATA_DIR') ?? defaultDataDir()

  if (problems.length > 0) {
    throw new ConfigError(`Invalid backend configuration:\n  - ${problems.join('\n  - ')}`)
  }

  return { port, host, issuer, audience, jwksUrl, clockSkewSeconds, dbPath, dataDir }
}
