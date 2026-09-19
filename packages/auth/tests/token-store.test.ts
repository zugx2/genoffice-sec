import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileTokenStore } from '../src/token-store.js'
import { TokenStoreError } from '../src/errors.js'
import type { StoredTokenSet } from '../src/types.js'

// ────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────

/** A valid stored set with overridable fields — note: no access token field exists at all */
function storedSet(overrides: Partial<StoredTokenSet> = {}): StoredTokenSet {
  return {
    refreshToken: 'refresh-1',
    idToken: 'header.payload.sig',
    profile: {
      sub: 'user-1',
      name: 'Alice',
      email: 'alice@example.test',
      preferredUsername: 'alice',
    },
    obtainedAt: 1_000_000,
    issuer: 'http://localhost:8080/realms/genoffice',
    ...overrides,
  }
}

/** Capture a rejection as a value (null when the promise resolves) */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  )
}

// ────────────────────────────────────────────────────────────
// FileTokenStore
// ────────────────────────────────────────────────────────────

describe('FileTokenStore', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genoffice-auth-store-'))
    path = join(dir, 'auth-store.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('save/load round-trip', () => {
    it('round-trips a stored set through disk', async () => {
      const store = new FileTokenStore({ path })

      await store.save(storedSet())
      await expect(store.load()).resolves.toEqual(storedSet())
    })

    it('writes a versioned JSON document without any access-token field', async () => {
      const store = new FileTokenStore({ path })

      await store.save(storedSet())

      const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
      expect(raw).toMatchObject({ version: 1, refreshToken: 'refresh-1' })
      expect(raw).not.toHaveProperty('accessToken')
    })

    it('creates missing parent directories and keeps the 0600 mode', async () => {
      const nested = join(dir, 'a', 'b', 'auth-store.json')
      const store = new FileTokenStore({ path: nested })

      await store.save(storedSet())
      await expect(store.load()).resolves.toEqual(storedSet())
      expect((await stat(nested)).mode & 0o777).toBe(0o600)
    })

    it('replaces previous content on a second save', async () => {
      const store = new FileTokenStore({ path })

      await store.save(storedSet())
      await store.save(storedSet({ refreshToken: 'refresh-2', obtainedAt: 2_000_000 }))

      await expect(store.load()).resolves.toEqual(
        storedSet({ refreshToken: 'refresh-2', obtainedAt: 2_000_000 }),
      )
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    })

    it('writes the file with mode 0600', async () => {
      const store = new FileTokenStore({ path })

      await store.save(storedSet())

      expect((await stat(path)).mode & 0o777).toBe(0o600)
    })
  })

  describe('load failure modes', () => {
    it('resolves with null when the file does not exist', async () => {
      const store = new FileTokenStore({ path })

      await expect(store.load()).resolves.toBeNull()
    })

    it('throws TokenStoreError (corrupt_file) on non-JSON content', async () => {
      await writeFile(path, '{not json', 'utf8')
      const store = new FileTokenStore({ path })

      const err = await rejectionOf(store.load())
      expect(err).toBeInstanceOf(TokenStoreError)
      expect((err as TokenStoreError).code).toBe('corrupt_file')
    })

    it('throws TokenStoreError (corrupt_file) on an unsupported version', async () => {
      await writeFile(path, JSON.stringify({ version: 99, refreshToken: 'x' }), 'utf8')
      const store = new FileTokenStore({ path })

      const err = await rejectionOf(store.load())
      expect(err).toBeInstanceOf(TokenStoreError)
      expect((err as TokenStoreError).code).toBe('corrupt_file')
      expect((err as TokenStoreError).message).toContain('99')
    })

    it('throws TokenStoreError (corrupt_file) on a version-1 document with missing fields', async () => {
      await writeFile(path, JSON.stringify({ version: 1 }), 'utf8')
      const store = new FileTokenStore({ path })

      const err = await rejectionOf(store.load())
      expect(err).toBeInstanceOf(TokenStoreError)
      expect((err as TokenStoreError).code).toBe('corrupt_file')
    })

    it('throws TokenStoreError (corrupt_file) on a profile without a sub claim', async () => {
      const broken = { ...storedSet(), profile: { name: 'NoSub' } }
      await writeFile(path, JSON.stringify({ version: 1, ...broken }), 'utf8')
      const store = new FileTokenStore({ path })

      const err = await rejectionOf(store.load())
      expect(err).toBeInstanceOf(TokenStoreError)
      expect((err as TokenStoreError).code).toBe('corrupt_file')
    })
  })

  describe('clear', () => {
    it('removes a previously saved set', async () => {
      const store = new FileTokenStore({ path })
      await store.save(storedSet())

      await store.clear()

      await expect(store.load()).resolves.toBeNull()
    })

    it('is a no-op (not an error) when there is no file', async () => {
      const store = new FileTokenStore({ path })

      await expect(store.clear()).resolves.toBeUndefined()
    })
  })

  describe('atomic write', () => {
    it('leaves no tmp file behind and keeps prior state when the write fails', async () => {
      // The store path points at a non-empty directory: the tmp file is
      // written fine, but the final rename onto the target cannot succeed.
      const target = join(dir, 'target')
      await mkdir(target)
      await writeFile(join(target, 'keep.txt'), 'prior content', 'utf8')
      const store = new FileTokenStore({ path: target })

      const err = await rejectionOf(store.save(storedSet()))
      expect(err).toBeInstanceOf(TokenStoreError)
      expect((err as TokenStoreError).code).toBe('io_error')
      expect((err as TokenStoreError).cause).toBeDefined()

      // No leftover *.tmp sibling — the directory holds only the target
      expect((await readdir(dir)).sort()).toEqual(['target'])
      // The pre-existing content is untouched (atomicity: no partial write)
      await expect(readFile(join(target, 'keep.txt'), 'utf8')).resolves.toBe('prior content')
    })
  })
})
