/**
 * Cloud-documents IPC contract between the shell main process and the
 * renderer's home cloud section (docs/cloud-backend-auth.md, Phase 7d
 * "Identity": recents/starred move to server-side metadata keyed by the
 * cloud document id). Channel names plus the exact wire payload types.
 *
 * Security invariants, same shape as `shared/auth-api.ts`:
 * - the renderer NEVER receives tokens or endpoint URLs — only the document
 *   metadata below, which the main-process registry fetched through the
 *   shared SSRF-gated backend client;
 * - every payload crossing these channels is zod-validated in the main
 *   process (`apps/shell/src/main/auth/cloud-docs-ipc.ts`), and a cloudId is
 *   only ever accepted as a non-empty bounded string, then URL-encoded on
 *   the wire — never interpolated into a path or URL.
 */

export const CLOUD_DOCS_CHANNELS = {
  /** cached document list (+ background refresh); the snapshot shape below */
  listDocuments: 'cloud:list-documents',
  /** star / unstar one document (offline-safe: queued + replayed) */
  toggleStarred: 'cloud:toggle-starred',
  /** record an open (server-side recents stamp) */
  markOpened: 'cloud:mark-opened',
  /** push: the registry's list changed (refresh finished / star replayed) */
  documentsChanged: 'cloud:documents-changed',
} as const

/** Document kinds the backend stores (mirrors DOCUMENT_KINDS in the routes). */
export type CloudDocumentKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'md' | 'html'

/**
 * One server-side document as listed by the registry — the cloud twin of the
 * local recents row. `cloudId` is the server-assigned id that now keys tabs,
 * stars, and the home cloud section (the local rows key on absolute path).
 */
export interface CloudDocumentEntry {
  /** server-assigned document id (the identity key, not a path) */
  cloudId: string
  name: string
  kind: CloudDocumentKind | string
  /** byte size of the current version */
  sizeBytes: number
  /** monotonic version counter (the If-Match value) */
  currentVersion: number
  /** UTC ISO strings from the server */
  createdAt: string
  updatedAt: string
  /** from `document_meta` */
  starred: boolean
  /** UTC ISO of the last open, null when never opened */
  lastOpenedAt: string | null
}

/**
 * Response of `cloud:list-documents`: the registry's cached list plus its
 * freshness state. `available` is false when there is no cached list under
 * the signed-in account (not signed in, or nothing synced yet).
 *
 * `stale` is the offline indicator: the last refresh attempt failed and the
 * list shown is the last-known one. `pendingStars` counts star toggles still
 * queued locally awaiting replay (a subset of the starred rows shown).
 */
export interface CloudDocumentsSnapshot {
  available: boolean
  documents: CloudDocumentEntry[]
  /** ms epoch of the last successful refresh (0 when never) */
  syncedAt: number
  stale: boolean
  /** star toggles queued locally, not yet delivered to the server */
  pendingStars: number
}

/** Why a `cloud:documents-changed` push fired (the renderer re-lists). */
export type CloudDocsChangeReason = 'refreshed' | 'starred' | 'opened'

/** Payload of the `cloud:documents-changed` push (the renderer re-lists). */
export interface CloudDocumentsChangedPayload {
  /** 'refreshed' = list re-synced, 'starred' = a star was applied, 'opened' = an open was stamped */
  reason: CloudDocsChangeReason
}

/**
 * The typed bridge the shell preload exposes as `window.aiOfficeCloud`. A
 * thin wrapper over the channels above — no validation of its own; the main
 * process validates every payload.
 */
export interface CloudDocsApi {
  /**
   * The cached document list. Serving is instant; when signed in the
   * registry also refreshes in the background and pushes
   * `cloud:documents-changed` when the list changed.
   */
  listDocuments(): Promise<CloudDocumentsSnapshot>
  /**
   * Star or unstar one document by cloudId. Offline-safe: the toggle is
   * applied to the cache immediately and queued for replay on the next
   * successful refresh (server last-write-wins on these fields).
   * Resolves to the updated snapshot.
   */
  toggleStarred(cloudId: string, starred: boolean): Promise<CloudDocumentsSnapshot>
  /**
   * Record that the user opened a cloud document (the server-side recents
   * stamp). Best-effort: failures are logged main-side, never thrown.
   */
  markOpened(cloudId: string): Promise<void>
  /** push: the registry's list changed; returns the unsubscribe */
  onDocumentsChanged(handler: (payload: CloudDocumentsChangedPayload) => void): () => void
}
