/**
 * The `storageMode` setting (src/main/auth/storage-mode.ts, Phase 7e): the
 * default, the persisted read-back, the one sanctioned mutation, and — most
 * importantly — the guard: choosing `remote`/`hybrid` without an active
 * session is refused with the typed error and the setting is unchanged.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseStorageMode, StorageModeStore, STORAGE_MODE_KEY } from '../src/main/auth/storage-mode'

let dir: string
let settingsPath: string
let signedIn: boolean

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'storage-mode-'))
  settingsPath = join(dir, 'app-settings.json')
  signedIn = false
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const makeStore = (): StorageModeStore =>
  new StorageModeStore({ settingsPath: () => settingsPath, sessionActive: () => signedIn })

describe('parseStorageMode', () => {
  it('reads the three modes and falls back to local for anything else', () => {
    expect(parseStorageMode('local')).toBe('local')
    expect(parseStorageMode('remote')).toBe('remote')
    expect(parseStorageMode('hybrid')).toBe('hybrid')
    expect(parseStorageMode('云端')).toBe('local')
    expect(parseStorageMode(undefined)).toBe('local')
    expect(parseStorageMode({ mode: 'remote' })).toBe('local')
    expect(parseStorageMode(null)).toBe('local')
  })
})

describe('StorageModeStore', () => {
  it('defaults to local when nothing is persisted', () => {
    expect(makeStore().get()).toBe('local')
  })

  it('reads a persisted mode back and caches it (the file only changes through set)', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ [STORAGE_MODE_KEY]: 'remote', uiLang: 'en' }),
      'utf8',
    )
    const store = makeStore()
    expect(store.get()).toBe('remote')
    // a hand-edit after the first read must not leak in: the cache is the
    // truth, because nothing else is allowed to write the key
    writeFileSync(settingsPath, JSON.stringify({ [STORAGE_MODE_KEY]: 'hybrid' }), 'utf8')
    expect(store.get()).toBe('remote')
  })

  it('persists through set without touching sibling settings', () => {
    writeFileSync(settingsPath, JSON.stringify({ uiLang: 'en' }), 'utf8')
    const store = makeStore()
    signedIn = true
    expect(store.set('hybrid')).toEqual({ ok: true, mode: 'hybrid', previous: 'local' })
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(stored[STORAGE_MODE_KEY]).toBe('hybrid')
    expect(stored.uiLang).toBe('en')
  })

  it('is a no-op success when the mode is already active', () => {
    const store = makeStore()
    expect(store.set('local')).toEqual({ ok: true, mode: 'local', previous: 'local' })
    expect(store.set('local')).toEqual({ ok: true, mode: 'local', previous: 'local' })
  })

  it('guards remote/hybrid behind an active session (typed error, setting unchanged)', () => {
    const store = makeStore()
    for (const mode of ['remote', 'hybrid'] as const) {
      expect(store.set(mode)).toEqual({ ok: false, error: 'sign-in-required', mode: 'local' })
    }
    expect(store.get()).toBe('local')
    // the refused mutation never wrote the file at all
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('allows local while signed out (signing out never strands the setting)', () => {
    const store = makeStore()
    signedIn = true
    expect(store.set('remote').ok).toBe(true)
    signedIn = false
    expect(store.get()).toBe('remote') // the setting STAYS after logout
    expect(store.set('local')).toEqual({ ok: true, mode: 'local', previous: 'remote' })
  })

  it('fires change listeners only on a real switch, and unsubscribe works', () => {
    const store = makeStore()
    const seen: string[] = []
    const off = store.onChange((mode) => seen.push(mode))
    signedIn = true
    store.set('remote')
    store.set('remote') // no-op: no event
    store.set('local') // back: event
    off()
    store.set('hybrid')
    expect(seen).toEqual(['remote', 'local'])
  })

  it('a fresh store instance reads what a previous one persisted', () => {
    signedIn = true
    const first = makeStore()
    first.set('hybrid')
    expect(
      new StorageModeStore({ settingsPath: () => settingsPath, sessionActive: () => true }).get(),
    ).toBe('hybrid')
  })
})
