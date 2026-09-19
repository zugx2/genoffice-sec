/**
 * File-backed token store.
 *
 * Persists a {@link StoredTokenSet} (refresh token + id token + profile
 * snapshot + metadata) as a versioned JSON document:
 *
 * - writes are atomic — the payload goes to a sibling `.tmp` file (created
 *   with mode `0600`) that is renamed over the target, so a crash mid-write
 *   never leaves a half-written credential file behind;
 * - a failed write removes its tmp file and leaves any prior content intact;
 * - a missing file loads as `null`; a corrupt file raises a typed
 *   `TokenStoreError` instead of crashing;
 * - access tokens are not part of the stored shape at all.
 *
 * The path arrives via the constructor and nothing else is ambient, so tests
 * point the store at a temp directory. `safeStorage` encryption is layered on
 * later as an Electron-side decorator over the same {@link TokenStore}
 * interface — this module stays Electron-free.
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { TokenStoreError } from './errors.js'
import type { FileTokenStoreOptions, StoredTokenSet, TokenStore, UserProfile } from './types.js'

/** On-disk document version; bump (and migrate) when the shape ever changes */
const STORE_VERSION = 1

/** Credential files are private to the current user, nothing else */
const FILE_MODE = 0o600

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(doc: Record<string, unknown>, field: string): string {
  const value = doc[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TokenStoreError(`Token store field "${field}" is missing or not a string`, {
      code: 'corrupt_file',
    })
  }
  return value
}

function optionalString(doc: Record<string, unknown>, field: string): string | undefined {
  const value = doc[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requireProfile(doc: Record<string, unknown>): UserProfile {
  const value = doc['profile']
  if (!isRecord(value)) {
    throw new TokenStoreError('Token store field "profile" is missing or not an object', {
      code: 'corrupt_file',
    })
  }
  const sub = value['sub']
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new TokenStoreError('Token store profile is missing a non-empty "sub"', {
      code: 'corrupt_file',
    })
  }
  return {
    sub,
    name: optionalString(value, 'name'),
    email: optionalString(value, 'email'),
    preferredUsername: optionalString(value, 'preferredUsername'),
  }
}

/**
 * Validate and map a stored document. Throws `TokenStoreError` (code
 * `corrupt_file`) on non-JSON content, a foreign `version`, and any missing
 * or ill-typed field.
 */
function parseStoredFile(raw: string, path: string): StoredTokenSet {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new TokenStoreError(`Token store at ${path} is not valid JSON`, {
      code: 'corrupt_file',
      cause,
    })
  }
  if (!isRecord(parsed)) {
    throw new TokenStoreError(`Token store at ${path} is not a JSON object`, {
      code: 'corrupt_file',
    })
  }
  if (parsed['version'] !== STORE_VERSION) {
    throw new TokenStoreError(
      `Token store at ${path} has unsupported version ${String(parsed['version'])} (expected ${STORE_VERSION})`,
      { code: 'corrupt_file' },
    )
  }

  const obtainedAt = parsed['obtainedAt']
  if (typeof obtainedAt !== 'number' || !Number.isFinite(obtainedAt)) {
    throw new TokenStoreError('Token store field "obtainedAt" is not a number', {
      code: 'corrupt_file',
    })
  }

  return {
    refreshToken: requireNonEmptyString(parsed, 'refreshToken'),
    idToken: requireNonEmptyString(parsed, 'idToken'),
    profile: requireProfile(parsed),
    obtainedAt,
    issuer: requireNonEmptyString(parsed, 'issuer'),
  }
}

export class FileTokenStore implements TokenStore {
  private readonly path: string

  constructor(options: FileTokenStoreOptions) {
    this.path = options.path
  }

  /**
   * The stored set, or `null` when no file exists. A file that exists but
   * does not parse/validate throws `TokenStoreError` (`corrupt_file`).
   */
  async load(): Promise<StoredTokenSet | null> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code
      if (code === 'ENOENT') return null
      throw new TokenStoreError(`Failed to read the token store at ${this.path}`, {
        code: 'io_error',
        cause,
      })
    }
    return parseStoredFile(raw, this.path)
  }

  /**
   * Atomically persist the set: write `<path>.tmp` with mode `0600`, then
   * rename it over the target. On any failure the tmp file is removed (no
   * leftovers) and any prior content stays untouched.
   */
  async save(tokenSet: StoredTokenSet): Promise<void> {
    const document = { version: STORE_VERSION, ...tokenSet }
    const payload = JSON.stringify(document)
    const tmpPath = `${this.path}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      // A stale tmp from an earlier crash could carry a wider mode; open()
      // only applies its mode on create, so remove it to guarantee a fresh
      // 0600 file (and the rename that carries the mode to the target).
      await rm(tmpPath, { force: true })
      const handle = await open(tmpPath, 'w', FILE_MODE)
      try {
        await handle.writeFile(payload, 'utf8')
      } finally {
        await handle.close()
      }
      await rename(tmpPath, this.path)
    } catch (cause) {
      await rm(tmpPath, { force: true }).catch(() => undefined)
      throw new TokenStoreError(`Failed to write the token store at ${this.path}`, {
        code: 'io_error',
        cause,
      })
    }
  }

  /** Remove the stored file; a no-op when there is none. */
  async clear(): Promise<void> {
    try {
      await rm(this.path, { force: true })
    } catch (cause) {
      throw new TokenStoreError(`Failed to clear the token store at ${this.path}`, {
        code: 'io_error',
        cause,
      })
    }
  }
}
