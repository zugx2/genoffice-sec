/**
 * Mode-switch migration (docs/cloud-backend-auth.md, "Document storage
 * modes" — "Switching modes offers migration"): the bulk move that follows a
 * `storageMode` change, `local → hybrid/remote` = upload every document in
 * the GenOffice documents folder, `remote → local/hybrid` = download every
 * server document into it.
 *
 * Never automatic: the Settings pane offers the move after a switch
 * (`MigrationOffer`), the user opts in, and only then does anything here run.
 * `hybrid → remote` and `hybrid → local` offer nothing — the working copies
 * are already local and mirrored, so there is nothing to move (documented in
 * docs/cloud-storage.md).
 *
 * The move is sequential (one document at a time, so a slow upload cannot
 * starve the others), reports one progress event per finished step, and is
 * non-fatal per document: a step that fails is listed with a stable error
 * code and a retry handle, the rest keep going. Re-running with exactly the
 * failed steps' handles retries only those — a succeeded document is never
 * re-copied, because an upload re-run would mint a server duplicate.
 */

import { basename } from 'node:path'
import { RemoteDocumentError } from '@genoffice/document-store'
import type { CloudDocumentEntry } from '../../shared/cloud-docs-api'
import type {
  MigrationFailure,
  MigrationOffer,
  MigrationProgressPayload,
  MigrateDocumentsResult,
  StorageMode,
} from '../../shared/storage-mode-api'

/** Stable failure codes — the renderer maps each to a localized line. */
export type MigrationErrorCode = 'unavailable' | 'not-found' | 'read-failed' | 'write-failed'

/** Everything the migration needs, injected (Electron-free, testable). */
export interface StorageMigrationDeps {
  /** an authenticated session is live (the whole move needs one) */
  sessionActive: () => boolean
  /** the GenOffice documents folder (uploads list it, downloads land in it) */
  documentsDir: () => string
  /**
   * Local documents worth uploading: every supported file under `dir`,
   * recursively (the folder tree's own listing — `collectTreeFiles`).
   */
  listLocalDocuments: (dir: string) => string[]
  /** the server document list (the registry's cached snapshot) */
  cloudDocuments: () => CloudDocumentEntry[]
  /** upload one local file (the router's `uploadDocument`) */
  upload: (path: string) => Promise<void>
  /** download one cloud document (the router's `downloadDocument`) */
  download: (
    cloudId: string,
    name: string,
  ) => Promise<{ ok: true; path: string } | { ok: false; error: 'unavailable' }>
  /** one step finished (the IPC layer pushes it to the requesting renderer) */
  onProgress: (payload: MigrationProgressPayload) => void
}

/** One step of the move, normalized over the two directions. */
interface MigrationStep {
  /** display name (the file name / server document name) */
  name: string
  /** the retry handle: the local path, or the cloud document id */
  source: string
  run: () => Promise<void>
}

/** File extensions the documents API accepts — mirrors KIND_BY_EXTENSION. */
const UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'md',
  'markdown',
  'html',
  'htm',
])

/** Extension appended to a download whose server name carries none. */
const EXTENSION_BY_KIND: Readonly<Record<string, string>> = {
  docx: '.docx',
  xlsx: '.xlsx',
  pptx: '.pptx',
  pdf: '.pdf',
  md: '.md',
  html: '.html',
}

/** Local files a `local → hybrid/remote` switch would upload. */
export function uploadableLocalDocuments(paths: string[]): string[] {
  return paths.filter((path) => UPLOAD_EXTENSIONS.has(extensionOf(path)))
}

function extensionOf(path: string): string {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * The local file name for a server document: the server name is user data,
 * so path separators and platform-hostile characters are stripped, and a
 * name without its extension gets the one the kind implies (otherwise the
 * downloaded file would never show in the folder tree).
 */
export function localNameForDocument(entry: CloudDocumentEntry): string {
  // eslint-disable-next-line no-control-regex -- the C0 range IS the check: server names must not carry controls into local file names
  const cleaned = entry.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  const base = cleaned === '' ? 'document' : cleaned
  if (/\.[a-z0-9]{1,12}$/i.test(base)) return base
  return `${base}${EXTENSION_BY_KIND[entry.kind] ?? '.bin'}`
}

/** Maps a step's failure to its stable code (never a raw message). */
function errorCodeOf(error: unknown): MigrationErrorCode {
  if (error instanceof RemoteDocumentError) {
    if (error.code === 'not_found') return 'not-found'
    return 'unavailable'
  }
  if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 'read-failed'
  return 'write-failed'
}

/**
 * Runs the bulk move. `retry` re-runs exactly the failed steps of a previous
 * run (upload handles are local paths, download handles are cloud ids); a
 * fresh run covers every document in the direction's source.
 */
export async function runStorageMigration(
  deps: StorageMigrationDeps,
  direction: 'upload' | 'download',
  retry?: string[],
): Promise<MigrateDocumentsResult> {
  if (!deps.sessionActive()) return { ok: false, error: 'sign-in-required' }
  const steps = direction === 'upload' ? uploadSteps(deps, retry) : downloadSteps(deps, retry)
  const failures: MigrationFailure[] = []
  let moved = 0
  let done = 0
  for (const step of steps) {
    try {
      await step.run()
      moved += 1
    } catch (error) {
      console.warn(`[storage-mode] migration step failed (${step.name}):`, error)
      failures.push({ name: step.name, error: errorCodeOf(error), source: step.source })
    }
    done += 1
    deps.onProgress({ done, total: steps.length, current: step.name, failures: [...failures] })
  }
  return { ok: true, moved, failures }
}

/** `local → hybrid/remote`: every uploadable file under the documents folder. */
function uploadSteps(deps: StorageMigrationDeps, retry?: string[]): MigrationStep[] {
  if (retry !== undefined) {
    // a retry addresses exact paths; a file that has since moved or vanished
    // fails its step (listed again) rather than being silently skipped
    return retry.map((path) => ({
      name: basename(path),
      source: path,
      run: () => deps.upload(path),
    }))
  }
  return uploadableLocalDocuments(deps.listLocalDocuments(deps.documentsDir())).map((path) => ({
    name: basename(path),
    source: path,
    run: () => deps.upload(path),
  }))
}

/** `remote → local/hybrid`: every document in the registry's cached list. */
function downloadSteps(deps: StorageMigrationDeps, retry?: string[]): MigrationStep[] {
  const documents = deps.cloudDocuments()
  if (retry !== undefined) {
    const byId = new Map(documents.map((entry) => [entry.cloudId, entry]))
    return retry.map((cloudId) => {
      const entry = byId.get(cloudId)
      return {
        name: entry ? localNameForDocument(entry) : cloudId,
        source: cloudId,
        run: async (): Promise<void> => {
          // the outcome is carried by the step's success/failure, not its value
          await deps.download(cloudId, entry ? localNameForDocument(entry) : `${cloudId}.bin`)
        },
      }
    })
  }
  return documents.map((entry) => ({
    name: localNameForDocument(entry),
    source: entry.cloudId,
    run: async (): Promise<void> => {
      await deps.download(entry.cloudId, localNameForDocument(entry))
    },
  }))
}

/**
 * The offer a successful mode switch returns: what a migration would move
 * right now. `null` when the switch changes nothing (the directions the
 * design leaves alone) — the renderer then shows no dialog at all.
 */
export function migrationOfferFor(
  previous: StorageMode,
  next: StorageMode,
  deps: Pick<StorageMigrationDeps, 'documentsDir' | 'listLocalDocuments' | 'cloudDocuments'>,
): MigrationOffer | null {
  if (previous === next) return null
  if (previous === 'local' && next !== 'local') {
    return {
      direction: 'upload',
      count: uploadableLocalDocuments(deps.listLocalDocuments(deps.documentsDir())).length,
    }
  }
  if (previous === 'remote' && next !== 'remote') {
    return { direction: 'download', count: deps.cloudDocuments().length }
  }
  // hybrid → anything: the working copies are local and already mirrored
  return null
}
