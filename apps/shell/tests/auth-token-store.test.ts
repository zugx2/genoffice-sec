import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { ElectronTokenStore, type SafeStorageLike } from '../src/main/auth/token-store-electron'
import type { StoredTokenSet } from '@genoffice/auth'

const STORED: StoredTokenSet = {
  refreshToken: 'refresh-1',
  idToken: 'id-token-1',
  profile: { sub: 'user-1', name: 'Alice', email: 'alice@example.test' },
  obtainedAt: 1_000_000,
  issuer: 'http://localhost:8080/realms/genoffice',
}

/** Deterministic stand-in for Electron's safeStorage (no keyring needed). */
function fakeSafeStorage(options: { available?: boolean; key?: string } = {}) {
  const key = () => options.key ?? 'k1'
  return {
    isEncryptionAvailable: () => options.available ?? true,
    encryptString: (plainText: string) =>
      Buffer.from(`enc(${key()})::${Buffer.from(plainText, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8')
      const marker = `enc(${key()})::`
      if (!text.startsWith(marker)) throw new Error('Cannot decrypt')
      return Buffer.from(text.slice(marker.length), 'base64').toString('utf8')
    },
  } satisfies SafeStorageLike
}

const dirs: string[] = []
async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'genoffice-auth-store-'))
  dirs.push(dir)
  return join(dir, name)
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ElectronTokenStore', () => {
  it('round-trips through encryption when the keyring is available', async () => {
    const path = await tempPath('cloud-auth.json')
    const safeStorage = fakeSafeStorage()
    const store = new ElectronTokenStore({ path, safeStorage })
    expect(store.storageKind).toBe('encrypted')

    await store.save(STORED)
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('refresh-1')
    expect(raw).not.toContain('{') // whole file is magic + ciphertext

    await expect(store.load()).resolves.toEqual(STORED)
  })

  it('writes the file with 0600 permissions and no tmp leftovers', async () => {
    const path = await tempPath('cloud-auth.json')
    const store = new ElectronTokenStore({ path, safeStorage: fakeSafeStorage() })
    await store.save(STORED)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(stat(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('falls back to the plain FileTokenStore format when the keyring is unavailable', async () => {
    const path = await tempPath('cloud-auth.json')
    const store = new ElectronTokenStore({
      path,
      safeStorage: fakeSafeStorage({ available: false }),
    })
    expect(store.storageKind).toBe('plain-file')

    await store.save(STORED)
    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ version: 1, refreshToken: 'refresh-1' })
    await expect(store.load()).resolves.toEqual(STORED)
  })

  it('reads a plain file saved earlier even after the keyring appears', async () => {
    const path = await tempPath('cloud-auth.json')
    const plain = new ElectronTokenStore({
      path,
      safeStorage: fakeSafeStorage({ available: false }),
    })
    await plain.save(STORED)

    // next run: keyring now works; the plain file must still load (and the
    // next save migrates it to encrypted)
    const upgraded = new ElectronTokenStore({ path, safeStorage: fakeSafeStorage() })
    await expect(upgraded.load()).resolves.toEqual(STORED)
    await upgraded.save(STORED)
    expect((await readFile(path, 'utf8')).startsWith('{')).toBe(false)
  })

  it('drops the session when the keyring vanished (cannot decrypt)', async () => {
    const path = await tempPath('cloud-auth.json')
    const encrypted = new ElectronTokenStore({ path, safeStorage: fakeSafeStorage() })
    await encrypted.save(STORED)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const keyless = new ElectronTokenStore({
        path,
        safeStorage: fakeSafeStorage({ available: false }),
      })
      await expect(keyless.load()).resolves.toBeNull()
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' }) // self-healed
    } finally {
      warn.mockRestore()
    }
  })

  it('drops the session when the keyring was re-keyed (decrypt fails)', async () => {
    const path = await tempPath('cloud-auth.json')
    await new ElectronTokenStore({ path, safeStorage: fakeSafeStorage({ key: 'k1' }) }).save(STORED)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const rekeyed = new ElectronTokenStore({ path, safeStorage: fakeSafeStorage({ key: 'k2' }) })
      await expect(rekeyed.load()).resolves.toBeNull()
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      warn.mockRestore()
    }
  })

  it('loads null for a missing file', async () => {
    const store = new ElectronTokenStore({
      path: join(await tempPath('dir'), 'absent.json'),
      safeStorage: fakeSafeStorage(),
    })
    await expect(store.load()).resolves.toBeNull()
  })

  it('clear removes the file', async () => {
    const path = await tempPath('cloud-auth.json')
    const store = new ElectronTokenStore({ path, safeStorage: fakeSafeStorage() })
    await store.save(STORED)
    await store.clear()
    await expect(store.load()).resolves.toBeNull()
  })

  it('falls back to plain parsing when a foreign binary file lacks the magic', async () => {
    // defense check: garbage that is not JSON and not our magic must surface
    // the wrapped store's corrupt-file error, not a decrypt attempt
    const path = await tempPath('cloud-auth.json')
    await writeFile(path, Buffer.from([0, 1, 2, 3]))
    const store = new ElectronTokenStore({ path, safeStorage: fakeSafeStorage() })
    await expect(store.load()).rejects.toMatchObject({ code: 'corrupt_file' })
  })
})
