/**
 * Storage-mode IPC registration (docs/cloud-backend-auth.md, Phase 7e — the
 * `storageMode` setting, its guard, open-from-cloud, and the mode-switch
 * migration).
 *
 * Six channels, every payload zod-validated at this edge (the auth IPC
 * precedent: outgoing pushes and responses are validated too, so a shape bug
 * fails loudly instead of drifting to the renderer):
 *
 * - `cloud:get-storage-mode` — the persisted mode + whether a session is live;
 * - `cloud:set-storage-mode` — the ONLY sanctioned mutation of the setting
 *   (enum-validated; remote/hybrid without a session → typed
 *   `sign-in-required`, the setting unchanged);
 * - `cloud:storage-mode-changed` — push, broadcast to every webContents on
 *   every mode change and session change (both re-resolve routing);
 * - `cloud:open-document` — open a cloud document by id, routed per mode
 *   (remote → scratch-backed docs tab keyed by cloudId; hybrid/local →
 *   download into the documents folder + a path-keyed tab);
 * - `cloud:migrate-documents` — run (or retry a subset of) the bulk move,
 *   refused with a typed error when the direction cannot run in the mode as
 *   it is now (`no-such-migration`);
 * - `cloud:migration-progress` — push, one per finished step, to the
 *   requesting webContents only.
 *
 * Registration also builds and owns the `DocumentStoreRouter` (exposed through
 * {@link getDocumentStoreRouter} — the shell installs it as the docs
 * editor's store via `setDocumentStore`) and the {@link StorageModeStore}.
 * The renderer never receives tokens or endpoint URLs through these
 * channels; a cloudId is only ever a non-empty bounded string, URL-encoded by
 * the transport below it.
 */

import { join } from 'node:path'
import { app, ipcMain, webContents } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { configuredDefaultSaveDir } from '@genoffice/electron-utils'
import type { BackendClient } from './backend-client'
import type { CloudDocumentsRegistry } from './cloud-docs'
import { getCloudDocumentsRegistry } from './cloud-docs-ipc'
import { getAuthSessionManager, getBackendClient } from './ipc'
import { DocumentStoreRouter } from './document-store-router'
import type { OpenCloudDocumentPlan } from './document-store-router'
import { StorageModeStore } from './storage-mode'
import { migrationOfferFor, runStorageMigration } from './storage-migration'
import { RemoteDocumentUnavailableError } from '@genoffice/document-store'
import type { DocumentTransport } from '@genoffice/document-store'
import type { CloudDocumentEntry } from '../../shared/cloud-docs-api'
import { STORAGE_MODE_CHANNELS } from '../../shared/storage-mode-api'
import type {
  MigrationOffer,
  MigrationProgressPayload,
  SetStorageModeResult,
  StorageMode,
  StorageModeState,
} from '../../shared/storage-mode-api'

// ── payload schemas (the wire contract, mirrored by shared/storage-mode-api.ts) ──

const cloudIdSchema = z.string().min(1).max(128)

const setStorageModeArgs = z.object({ mode: z.enum(['local', 'remote', 'hybrid']) }).strict()

const openDocumentArgs = z.object({ cloudId: cloudIdSchema }).strict()

const migrateDocumentsArgs = z
  .object({
    direction: z.enum(['upload', 'download']),
    retry: z.array(z.string().min(1).max(1024)).max(10_000).optional(),
  })
  .strict()

const noArguments = z.union([z.undefined(), z.null()])

const failureSchema = z
  .object({
    name: z.string(),
    error: z.enum(['unavailable', 'not-found', 'read-failed', 'write-failed']),
    source: z.string().min(1),
  })
  .strict()

const storageModeStateSchema = z
  .object({ mode: z.enum(['local', 'remote', 'hybrid']), signedIn: z.boolean() })
  .strict()

const setStorageModeResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      mode: z.enum(['local', 'remote', 'hybrid']),
      migration: z
        .object({
          direction: z.enum(['upload', 'download']),
          count: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: z.literal('sign-in-required') }).strict(),
])

const openDocumentResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum(['sign-in-required', 'unsupported-kind', 'not-found', 'unavailable']),
    })
    .strict(),
])

const migrationProgressSchema = z
  .object({
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    current: z.string(),
    failures: z.array(failureSchema),
  })
  .strict()

const migrateDocumentsResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      moved: z.number().int().nonnegative(),
      failures: z.array(failureSchema),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum(['sign-in-required', 'no-such-migration']),
    })
    .strict(),
])

/**
 * Whether `direction` can run while `mode` is the CURRENT mode — the same
 * matrix {@link migrationOfferFor} encodes: an offer is returned by a mode
 * switch and shown after it completed, so its direction is always legal for
 * the mode the switch landed on. `local → remote/hybrid` offers upload,
 * `remote → local/hybrid` offers download, and `hybrid` is reachable from
 * either origin, so both of its directions exist. A direction outside that
 * set cannot move anything sane — an upload while still `local` would
 * rewrite documents onto themselves through the local adapter, a download
 * while still `remote` would intern download targets the server bytes never
 * land at — so the handler refuses it with the typed `no-such-migration`
 * instead of running it.
 */
function directionRunnableIn(mode: StorageMode, direction: 'upload' | 'download'): boolean {
  if (mode === 'hybrid') return true
  return mode === 'local' ? direction === 'download' : direction === 'upload'
}

export interface StorageModeIpcDeps {
  /** app-settings.json path (the storageMode key lives there) */
  settingsPath?: string
  /** the remote adapter's scratch dir (wiped on exit, swept at startup) */
  scratchDir?: string
  /** the path → cloudId association index (userData/cloud-document-index.json) */
  associationIndexPath?: string
  /** `LocalDocumentStore` root (userData: recovery copies + originals) */
  localRootDir?: string
  /** the GenOffice documents folder */
  documentsDir?: () => string
  /**
   * Local documents under a folder (the folder tree's recursive listing —
   * `collectTreeFiles`); the upload migration lists the documents folder.
   */
  listLocalDocuments?: (dir: string) => string[]
  /** the cloud-documents registry (default: the registered one) */
  registry?: () => CloudDocumentsRegistry | undefined
  /** an authenticated session is live (default: the auth session manager) */
  sessionActive?: () => boolean
  /** the shared backend client (default: the auth IPC one) */
  client?: () => Promise<BackendClient> | undefined
  /** act on an open plan (default: none — the shell passes the tab manager's) */
  openCloudTab?: (plan: OpenCloudDocumentPlan) => boolean
  /** bind a minted cloud id onto the tab holding the path (setTabCloudIdFor) */
  bindTabCloudId?: (path: string, cloudId: string) => void
  /** open tabs follow a cloud id re-point (the tab manager's rekeyTabCloudId) */
  rekeyTabs?: (oldCloudId: string, newCloudId: string) => void
  /** exit-hook registration for the scratch wipe */
  onExit?: (wipe: () => void) => void
}

/** The module-scoped state (one per process, built on registration). */
let modeStore: StorageModeStore | undefined
let router: DocumentStoreRouter | undefined

/** The persisted storageMode store — undefined until `registerStorageModeIpc` ran. */
export function getStorageModeStore(): StorageModeStore | undefined {
  return modeStore
}

/**
 * The document-store router the shell installs as the docs editor's store
 * (`setDocumentStore`) — undefined until `registerStorageModeIpc` ran.
 */
export function getDocumentStoreRouter(): DocumentStoreRouter | undefined {
  return router
}

/** Registers the channels and builds the router + mode store. Idempotent. */
export function registerStorageModeIpc(deps: StorageModeIpcDeps = {}): void {
  if (router !== undefined) return
  const sessionActive =
    deps.sessionActive ??
    ((): boolean => getAuthSessionManager()?.snapshot().status === 'authenticated')
  const registry = deps.registry ?? getCloudDocumentsRegistry
  const client = deps.client ?? getBackendClient
  // the GenOffice documents folder (the editors' own default save dir:
  // user-configurable, <Documents>/GenOffice by default)
  const documentsDir = deps.documentsDir ?? ((): string => configuredDefaultSaveDir(app))

  modeStore = new StorageModeStore({
    settingsPath: (): string =>
      deps.settingsPath ?? join(app.getPath('userData'), 'app-settings.json'),
    sessionActive,
  })

  // the transport resolves the shared client per call: construction is
  // SSRF-gated and config-lazy, and auth state is always current. Without a
  // client there is no transport — exactly the remote adapter's "unavailable".
  const transport: DocumentTransport = async (path, init) => {
    const resolved = await client()
    if (resolved === undefined) {
      throw new RemoteDocumentUnavailableError('no cloud backend client is configured')
    }
    return resolved.fetch(path, init)
  }

  router = new DocumentStoreRouter({
    mode: (): StorageMode => modeStore!.get(),
    sessionActive,
    transport,
    localRootDir: deps.localRootDir ?? app.getPath('userData'),
    scratchDir: deps.scratchDir ?? join(app.getPath('userData'), 'cloud-scratch'),
    indexPath:
      deps.associationIndexPath ?? join(app.getPath('userData'), 'cloud-document-index.json'),
    documentsDir,
    registry,
    rekeyTabs: deps.rekeyTabs,
    onCloudIdMinted: deps.bindTabCloudId,
    onPendingUpload: (pending) => {
      // surfaced, never thrown: the local save landed, the mirror rides the next one
      console.warn('[storage-mode] hybrid mirror pending:', pending.path, pending.error)
    },
    onConflict: (conflict) => {
      // surfaced, never thrown: the save landed as a copy beside the diverging original
      console.warn(
        '[storage-mode] conflict copy created:',
        conflict.path,
        `${conflict.previousCloudId} → ${conflict.cloudId}`,
      )
    },
    onExit: deps.onExit,
  })

  const broadcastState = (): void => {
    const state: StorageModeState = storageModeStateSchema.parse({
      mode: modeStore!.get(),
      signedIn: sessionActive(),
    })
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send(STORAGE_MODE_CHANNELS.storageModeChanged, state)
    }
  }

  // a mode change re-resolves routing for every later op; a session change
  // flips the logout fallback — both are broadcast so every pane re-reads
  modeStore.onChange(broadcastState)
  getAuthSessionManager()?.onSessionChanged(broadcastState)

  // the Task 14 carry-over: a cloud id the registry itself re-keyed (another
  // subscriber's rekeyDocument) must reach the open tabs too
  registry()?.onDocumentRekeyed((oldCloudId, newCloudId) => {
    deps.rekeyTabs?.(oldCloudId, newCloudId)
  })

  ipcMain.handle(STORAGE_MODE_CHANNELS.getStorageMode, (_event, input: unknown) => {
    noArguments.parse(input)
    return storageModeStateSchema.parse({ mode: modeStore!.get(), signedIn: sessionActive() })
  })

  ipcMain.handle(STORAGE_MODE_CHANNELS.setStorageMode, async (_event, input: unknown) => {
    const { mode } = setStorageModeArgs.parse(input)
    const outcome = modeStore!.set(mode)
    if (!outcome.ok) return setStorageModeResultSchema.parse({ ok: false, error: outcome.error })
    // the offer's download count comes from the freshest list the registry
    // can serve (best-effort refresh; a failure falls back to the cache)
    if (outcome.previous === 'remote' && outcome.mode !== 'remote') {
      await registry()
        ?.refresh()
        .catch((error: unknown) => console.warn('[storage-mode] pre-offer refresh failed:', error))
    }
    const migration: MigrationOffer | null = migrationOfferFor(outcome.previous, outcome.mode, {
      documentsDir,
      listLocalDocuments: deps.listLocalDocuments ?? ((): string[] => []),
      cloudDocuments: (): CloudDocumentEntry[] => registry()?.snapshot().documents ?? [],
    })
    const result: SetStorageModeResult = {
      ok: true,
      mode: outcome.mode,
      ...(migration !== null ? { migration } : {}),
    }
    return setStorageModeResultSchema.parse(result)
  })

  ipcMain.handle(STORAGE_MODE_CHANNELS.openDocument, async (_event, input: unknown) => {
    const { cloudId } = openDocumentArgs.parse(input)
    const outcome = await router!.openCloudDocument(cloudId)
    if (!outcome.ok) return openDocumentResultSchema.parse({ ok: false, error: outcome.error })
    const opened = deps.openCloudTab?.(outcome.plan) ?? false
    return openDocumentResultSchema.parse(
      opened ? { ok: true } : { ok: false, error: 'unavailable' },
    )
  })

  ipcMain.handle(
    STORAGE_MODE_CHANNELS.migrateDocuments,
    async (event: IpcMainInvokeEvent, input: unknown) => {
      const { direction, retry } = migrateDocumentsArgs.parse(input)
      // the edge check: the caller's direction must still match the mode as
      // it is NOW (a dialog can outlive the switch it was offered by)
      if (!directionRunnableIn(modeStore!.get(), direction)) {
        return migrateDocumentsResultSchema.parse({ ok: false, error: 'no-such-migration' })
      }
      const sender = event.sender
      // the freshest list the registry can serve: downloads enumerate it
      await registry()
        ?.refresh()
        .catch((error: unknown) =>
          console.warn('[storage-mode] pre-migration refresh failed:', error),
        )
      const documents = registry()?.snapshot().documents ?? []
      const result = await runStorageMigration(
        {
          sessionActive,
          documentsDir,
          listLocalDocuments: deps.listLocalDocuments ?? ((): string[] => []),
          cloudDocuments: (): CloudDocumentEntry[] => documents,
          upload: (path) => router!.uploadDocument(path),
          download: (cloudId, name) =>
            router!.downloadDocument(cloudId, name, router!.activeStore()),
          onProgress: (payload: MigrationProgressPayload) => {
            if (!sender.isDestroyed()) {
              sender.send(
                STORAGE_MODE_CHANNELS.migrationProgress,
                migrationProgressSchema.parse(payload),
              )
            }
          },
        },
        direction,
        retry,
      )
      return migrateDocumentsResultSchema.parse(result)
    },
  )
}
