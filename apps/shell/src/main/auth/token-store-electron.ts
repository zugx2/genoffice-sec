/**
 * Electron-side token persistence: a `safeStorage` decorator over the
 * auth package's {@link TokenStore} seam.
 *
 * - while the OS keyring is available (`safeStorage.isEncryptionAvailable`,
 *   libsecret on Linux, Keychain on macOS, DPAPI on Windows) the persisted
 *   JSON document is encrypted with `safeStorage.encryptString` before it
 *   touches disk;
 * - on WSL2 / headless Linux the keyring reports unavailable, so the store
 *   falls back to the plain `FileTokenStore` (still atomic, still 0600) —
 *   that mode is surfaced to the renderer via `auth:get-session`
 *   (`storage: 'plain-file'`) so the Settings pane can warn;
 * - an encrypted file left over from a run whose keyring has since vanished
 *   (or been re-keyed) cannot be decrypted: the session is lost, the file
 *   is removed, and the store reports "no session" instead of failing
 *   startup.
 *
 * The encrypted format is `MAGIC || safeStorage.encryptString(json)` where
 * `json` is the exact document the plain store persists — the magic prefix
 * makes the format self-describing and can never prefix the plain format,
 * which always starts with `{`.
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { FileTokenStore, TokenStoreError } from '@genoffice/auth'
import type { StoredTokenSet, TokenStore } from '@genoffice/auth'
import type { AuthStorageKind } from '../../shared/auth-api'

/** The electron seam, injectable so tests run without a keyring. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface ElectronTokenStoreOptions {
  /** credential file path (created with mode 0600) */
  path: string
  safeStorage: SafeStorageLike
}

/** Encrypted-file marker; `{`-leading plain JSON can never match it. */
const MAGIC = Buffer.from('genoffice-safe-storage-v1\n')

/** Credential files are private to the current user, nothing else */
const FILE_MODE = 0o600

/** On-disk document version; matches the plain FileTokenStore's shape */
const STORE_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(doc: Record<string, unknown>, field: string): string | undefined {
  const value = doc[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Validate the decrypted document back into a {@link StoredTokenSet}.
 * Returns null (after a warning) when the shape is foreign — a decrypt that
 * produced garbage means the keyring changed, which is not a condition the
 * user can repair, so the caller self-heals by dropping the file.
 */
function parseDecryptedDocument(json: string): StoredTokenSet | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed['version'] !== STORE_VERSION) return null
  const refreshToken = nonEmptyString(parsed, 'refreshToken')
  const idToken = nonEmptyString(parsed, 'idToken')
  const issuer = nonEmptyString(parsed, 'issuer')
  const obtainedAt = parsed['obtainedAt']
  const profile = parsed['profile']
  if (!refreshToken || !idToken || !issuer) return null
  if (typeof obtainedAt !== 'number' || !Number.isFinite(obtainedAt)) return null
  if (!isRecord(profile)) return null
  const sub = nonEmptyString(profile, 'sub')
  if (!sub) return null
  return {
    refreshToken,
    idToken,
    issuer,
    obtainedAt,
    profile: {
      sub,
      name: nonEmptyString(profile, 'name'),
      email: nonEmptyString(profile, 'email'),
      preferredUsername: nonEmptyString(profile, 'preferredUsername'),
    },
  }
}

export class ElectronTokenStore implements TokenStore {
  private readonly path: string
  private readonly safeStorage: SafeStorageLike
  /** plain fallback engine (also the reader/validator for plain files) */
  private readonly plain: FileTokenStore

  constructor(options: ElectronTokenStoreOptions) {
    this.path = options.path
    this.safeStorage = options.safeStorage
    this.plain = new FileTokenStore({ path: options.path })
  }

  /** `'encrypted'` while the keyring works, `'plain-file'` in the fallback. */
  get storageKind(): AuthStorageKind {
    return this.safeStorage.isEncryptionAvailable() ? 'encrypted' : 'plain-file'
  }

  async save(tokenSet: StoredTokenSet): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) return this.plain.save(tokenSet)
    // The exact document the plain store would persist, encrypted at rest.
    const json = JSON.stringify({ version: STORE_VERSION, ...tokenSet })
    const payload = Buffer.concat([MAGIC, this.safeStorage.encryptString(json)])
    await this.writeAtomic(payload)
  }

  async load(): Promise<StoredTokenSet | null> {
    let bytes: Buffer
    try {
      bytes = await readFile(this.path)
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code
      if (code === 'ENOENT') return null
      throw new TokenStoreError(`Failed to read the token store at ${this.path}`, {
        code: 'io_error',
        cause,
      })
    }
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
      // plain format (current fallback mode or a pre-encryption file): the
      // wrapped engine owns parsing and validation
      return this.plain.load()
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return this.dropUndecryptable('the OS keyring is no longer available')
    }
    let json: string
    try {
      json = this.safeStorage.decryptString(bytes.subarray(MAGIC.length))
    } catch (cause) {
      return this.dropUndecryptable('decrypting the stored credentials failed', cause)
    }
    const stored = parseDecryptedDocument(json)
    if (stored === null) return this.dropUndecryptable('the decrypted credentials were malformed')
    return stored
  }

  async clear(): Promise<void> {
    return this.plain.clear()
  }

  /**
   * Atomic byte write with the plain store's discipline: payload to a
   * sibling `.tmp` (0600 on create, stale copies removed first), renamed
   * over the target so a crash never leaves a half-written credential file.
   */
  private async writeAtomic(payload: Buffer): Promise<void> {
    const tmpPath = `${this.path}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await rm(tmpPath, { force: true })
      const handle = await open(tmpPath, 'w', FILE_MODE)
      try {
        await handle.writeFile(payload)
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

  /**
   * An encrypted file we cannot read back is dead weight from a previous
   * keyring: drop it (best-effort) and report "no session" rather than
   * failing — the user re-authenticates with the device flow.
   */
  private async dropUndecryptable(reason: string, cause?: unknown): Promise<null> {
    if (cause !== undefined) console.warn(`[auth] ${reason}:`, cause)
    else console.warn(`[auth] ${reason}; dropping the stored session`)
    await rm(this.path, { force: true }).catch(() => undefined)
    return null
  }
}
