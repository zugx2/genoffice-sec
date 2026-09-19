/**
 * Cloud-auth configuration for the shell main process.
 *
 * Sources, in precedence order (docs/cloud-backend-auth.md §B "Config
 * plumbing"):
 *
 * 1. `process.env` — `GENOFFICE_AUTH_ISSUER`, `GENOFFICE_AUTH_CLIENT_ID`,
 *    `GENOFFICE_BACKEND_URL`. Dev/test override; like every env-var
 *    override point it presupposes control of the process environment.
 * 2. electron-builder `extraMetadata` written into the packaged app's
 *    package.json at build time (`genofficeAuth` / `genofficeBackend`
 *    blocks, apps/shell/electron-builder.cjs — the GA4 pattern). Only read
 *    when packaged; source builds never see injected credentials.
 * 3. Dev defaults pointing at the local docker Keycloak
 *    (docker/keycloak/docker-compose.yml) and the local backend skeleton.
 *
 * The result is typed and frozen; consumers treat it as read-only.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** Configured OIDC issuer / client / backend base URL. */
export interface ShellAuthConfig {
  /** e.g. http://localhost:8080/realms/genoffice (dev default) */
  readonly issuer: string
  /** public client with the device grant enabled */
  readonly clientId: string
  /** cloud backend base URL (consumed from Phase 5 on) */
  readonly backendUrl: string
}

/** Dev anchor: the realm imported by docker/keycloak/docker-compose.yml */
export const DEV_AUTH_ISSUER = 'http://localhost:8080/realms/genoffice'
/** Dev anchor: the public device-grant client in that realm import */
export const DEV_AUTH_CLIENT_ID = 'genoffice-desktop'
/**
 * Dev anchor for the backend service (Phase 4 scaffolds it; Phase 5
 * consumes it). Distinct from Keycloak's 8080 on purpose.
 */
export const DEV_BACKEND_URL = 'http://localhost:8000'

/**
 * Accept `http(s)://…` base URLs only: absolute, no credentials, no query,
 * no fragment — mirroring the build-time check in electron-builder.cjs so
 * an env override can never smuggle a userinfo-bearing or relative issuer
 * past the origin gate. Returns null for unset/invalid values.
 */
function httpBaseUrlOrNull(name: string, value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('invalid')
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    console.warn(`[auth] ignoring invalid ${name}:`, value)
    return null
  }
}

function nonEmptyStringOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** Extract `genofficeAuth` / `genofficeBackend` from a parsed package.json. */
function fromPackagedPackageJson(pkg: unknown): {
  issuer: string | null
  clientId: string | null
  backendUrl: string | null
} {
  if (!pkg || typeof pkg !== 'object') return { issuer: null, clientId: null, backendUrl: null }
  const record = pkg as Record<string, unknown>
  const read = (block: string, field: string): string | null => {
    const section = record[block]
    if (!section || typeof section !== 'object') return null
    const value = (section as Record<string, unknown>)[field]
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  return {
    issuer: read('genofficeAuth', 'issuer'),
    clientId: read('genofficeAuth', 'clientId'),
    backendUrl: read('genofficeBackend', 'baseUrl'),
  }
}

/** Injectable seams so tests drive resolution without touching electron. */
export interface ResolveAuthConfigOptions {
  env?: Record<string, string | undefined>
  isPackaged?: boolean
  /** directory whose package.json carries the injected extraMetadata */
  appPath?: string
  /** parsed package.json override (wins over reading `appPath` from disk) */
  pkg?: unknown
}

export function resolveAuthConfig(options: ResolveAuthConfigOptions = {}): ShellAuthConfig {
  const env = options.env ?? process.env

  let packaged: { issuer: string | null; clientId: string | null; backendUrl: string | null } = {
    issuer: null,
    clientId: null,
    backendUrl: null,
  }
  if (options.isPackaged ?? app.isPackaged) {
    packaged =
      options.pkg !== undefined
        ? fromPackagedPackageJson(options.pkg)
        : readPackagedConfig(options.appPath ?? app.getAppPath())
  }

  const issuer =
    httpBaseUrlOrNull('GENOFFICE_AUTH_ISSUER', env['GENOFFICE_AUTH_ISSUER']) ??
    httpBaseUrlOrNull('packaged genofficeAuth.issuer', packaged.issuer) ??
    DEV_AUTH_ISSUER
  const clientId =
    nonEmptyStringOrNull(env['GENOFFICE_AUTH_CLIENT_ID']) ?? packaged.clientId ?? DEV_AUTH_CLIENT_ID
  const backendUrl =
    httpBaseUrlOrNull('GENOFFICE_BACKEND_URL', env['GENOFFICE_BACKEND_URL']) ??
    httpBaseUrlOrNull('packaged genofficeBackend.baseUrl', packaged.backendUrl) ??
    DEV_BACKEND_URL

  return Object.freeze({ issuer, clientId, backendUrl })
}

/** Packaged extraMetadata only; every read failure falls back to dev defaults. */
function readPackagedConfig(appPath: string) {
  try {
    return fromPackagedPackageJson(JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')))
  } catch {
    return { issuer: null, clientId: null, backendUrl: null }
  }
}

let cached: ShellAuthConfig | undefined

/** Memoized startup read — the config is frozen, so sharing is safe. */
export function getShellAuthConfig(): ShellAuthConfig {
  return (cached ??= resolveAuthConfig())
}

/** Test hook: drop the memo so a changed environment re-resolves. */
export function resetShellAuthConfigCache(): void {
  cached = undefined
}
