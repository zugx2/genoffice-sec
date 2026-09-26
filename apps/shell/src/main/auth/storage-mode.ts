/**
 * The `storageMode` setting (docs/cloud-backend-auth.md, "Document storage
 * modes" — Phase 7e). One key in the shell's `app-settings.json`:
 *
 * - `local` (default): today's behavior, available to everyone;
 * - `remote` / `hybrid`: require an active session — selecting either while
 *   signed out is refused (`sign-in-required`) and the setting is unchanged.
 *
 * The setting is ONLY changed through the Settings UI's
 * `cloud:set-storage-mode` channel (zod, enum-validated, in
 * `auth/storage-mode-ipc.ts`); nothing else writes the key. On logout the
 * setting STAYS and routing falls back to local behavior (the router's
 * concern, `auth/document-store-router.ts`) — documented in
 * docs/cloud-storage.md.
 */

import { readAppSettings, writeAppSetting } from '../app-settings'
import { STORAGE_MODES, type StorageMode } from '../../shared/storage-mode-api'

/** The app-settings.json key. */
export const STORAGE_MODE_KEY = 'storageMode'

/** Parses a stored value into a mode; anything else reads as the default. */
export function parseStorageMode(raw: unknown): StorageMode {
  return STORAGE_MODES.includes(raw as StorageMode) ? (raw as StorageMode) : 'local'
}

export interface StorageModeStoreDeps {
  /** app-settings.json path (userData-scoped in the app, temp in tests) */
  settingsPath: () => string
  /** an authenticated session is live (the remote/hybrid guard) */
  sessionActive: () => boolean
}

export type SetStorageModeOutcome =
  | { ok: true; mode: StorageMode; previous: StorageMode }
  | { ok: false; error: 'sign-in-required'; mode: StorageMode }

/**
 * Cached reader/writer for the mode key. `set` is the guarded, only sanctioned
 * mutation: it validates the session requirement, persists, and notifies the
 * change listeners (the IPC layer broadcasts them). Reads never touch the
 * disk after the first call — the file only changes through this class.
 */
export class StorageModeStore {
  private readonly settingsPath: () => string
  private readonly sessionActive: () => boolean
  private cache: StorageMode | null = null
  private readonly listeners = new Set<(mode: StorageMode) => void>()

  constructor(deps: StorageModeStoreDeps) {
    this.settingsPath = deps.settingsPath
    this.sessionActive = deps.sessionActive
  }

  /** The persisted mode (default `local`; the value is cached per process). */
  get(): StorageMode {
    if (this.cache === null) {
      this.cache = parseStorageMode(readAppSettings(this.settingsPath())[STORAGE_MODE_KEY])
    }
    return this.cache
  }

  set(mode: StorageMode): SetStorageModeOutcome {
    if (mode !== 'local' && !this.sessionActive()) {
      // the guard: remote/hybrid keep a server copy of every save, and there
      // is no session to save through — refuse and leave the setting alone
      return { ok: false, error: 'sign-in-required', mode: this.get() }
    }
    const previous = this.get()
    if (mode === previous) return { ok: true, mode, previous }
    writeAppSetting(this.settingsPath(), STORAGE_MODE_KEY, mode)
    this.cache = mode
    for (const listener of [...this.listeners]) listener(mode)
    return { ok: true, mode, previous }
  }

  /** Fired after a successful `set` (the IPC layer broadcasts to renderers). */
  onChange(handler: (mode: StorageMode) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }
}
