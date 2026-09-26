/**
 * Storage-mode IPC contract between the shell main process and the renderer
 * (docs/cloud-backend-auth.md, "Document storage modes" — the `storageMode`
 * setting, its guard, mode-switch migration, and open-from-cloud).
 *
 * Security invariants, same shape as `shared/cloud-docs-api.ts`:
 * - the renderer NEVER receives tokens or endpoint URLs — the mode, the
 *   migration counters, and typed error codes are the whole surface;
 * - every payload crossing these channels is zod-validated in the main
 *   process (`apps/shell/src/main/auth/storage-mode-ipc.ts`), and a cloudId is
 *   only ever accepted as a non-empty bounded string, then URL-encoded by the
 *   transport below it — never interpolated into a path or URL.
 */

/** Where document files live (docs/cloud-backend-auth.md, the modes table). */
export type StorageMode = 'local' | 'remote' | 'hybrid'

export const STORAGE_MODES: readonly StorageMode[] = ['local', 'remote', 'hybrid']

export const STORAGE_MODE_CHANNELS = {
  /** the persisted mode + whether a session is live (the guard's input) */
  getStorageMode: 'cloud:get-storage-mode',
  /** switch the mode (guarded: remote/hybrid require an active session) */
  setStorageMode: 'cloud:set-storage-mode',
  /** push: the mode changed (broadcast to every webContents) */
  storageModeChanged: 'cloud:storage-mode-changed',
  /** open a cloud document by id (routed per mode) */
  openDocument: 'cloud:open-document',
  /** run (or retry a subset of) a bulk mode-switch migration */
  migrateDocuments: 'cloud:migrate-documents',
  /** push: one migration step finished (sent to the requesting webContents) */
  migrationProgress: 'cloud:migration-progress',
} as const

/** Response of `cloud:get-storage-mode`. */
export interface StorageModeState {
  mode: StorageMode
  /** an authenticated session is live (remote/hybrid are selectable) */
  signedIn: boolean
}

/**
 * The bulk move a mode switch may offer (docs/cloud-backend-auth.md:
 * local → hybrid/remote = upload; remote → local/hybrid = download). Opt-in:
 * the dialog offering it lives in the Settings pane, nothing runs by itself.
 */
export interface MigrationOffer {
  direction: 'upload' | 'download'
  /** documents the move would cover (0 still offers, so the user sees "nothing to move") */
  count: number
}

export type SetStorageModeResult =
  | { ok: true; mode: StorageMode; migration?: MigrationOffer }
  /** choosing remote/hybrid while signed out: the setting is unchanged */
  | { ok: false; error: 'sign-in-required' }

/**
 * Typed failures of `cloud:open-document`. The renderer maps each code to a
 * localized message; no server text, URL, or path ever crosses.
 */
export type OpenCloudDocumentError =
  /** no authenticated session: cloud documents are read-only-until-signin */
  | 'sign-in-required'
  /** not a docs document (xlsx/pptx/pdf/md/html editors roll out with T17) */
  | 'unsupported-kind'
  /** the id is not in the registry's list */
  | 'not-found'
  /** the download/upload transport failed */
  | 'unavailable'

export type OpenCloudDocumentResult = { ok: true } | { ok: false; error: OpenCloudDocumentError }

/** One migration step that did not land (surfaced by name, retryable). */
export interface MigrationFailure {
  /** display name (the file name / server document name) */
  name: string
  /** stable failure code — the renderer maps it to a localized line */
  error: 'unavailable' | 'not-found' | 'read-failed' | 'write-failed'
  /**
   * The retry handle: the local path for an upload step, the cloud document
   * id for a download step. Re-running the migration with exactly these
   * retries only the failed steps — a succeeded document is never re-copied
   * (an upload re-run would mint a server duplicate).
   */
  source: string
}

/** Push payload of `cloud:migration-progress` (one per finished step). */
export interface MigrationProgressPayload {
  /** finished steps (successful + failed) */
  done: number
  /** total steps in this run */
  total: number
  /** the document this step handled */
  current: string
  /** failures so far, oldest first (the results list grows monotonically) */
  failures: MigrationFailure[]
}

export type MigrateDocumentsResult =
  | {
      ok: true
      /** steps that landed */
      moved: number
      /** steps that did not (retry re-runs exactly these) */
      failures: MigrationFailure[]
    }
  | { ok: false; error: 'sign-in-required' | 'no-such-migration' }

/**
 * The typed bridge the shell preload exposes as `window.aiOfficeStorage`. A
 * thin wrapper over the channels above — no validation of its own; the main
 * process validates every payload.
 */
export interface StorageModeApi {
  getStorageMode(): Promise<StorageModeState>
  setStorageMode(mode: StorageMode): Promise<SetStorageModeResult>
  /** push: the persisted mode changed; returns the unsubscribe */
  onStorageModeChanged(handler: (state: StorageModeState) => void): () => void
  openDocument(cloudId: string): Promise<OpenCloudDocumentResult>
  /**
   * Run a bulk migration. Omit `retry` for a fresh run; pass a previous
   * result's failure `source` handles to re-run exactly those (retryable,
   * never automatic).
   */
  migrateDocuments(
    direction: 'upload' | 'download',
    retry?: string[],
  ): Promise<MigrateDocumentsResult>
  /** push: one migration step finished; returns the unsubscribe */
  onMigrationProgress(handler: (payload: MigrationProgressPayload) => void): () => void
}
