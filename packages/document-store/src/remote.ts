/**
 * Remote `DocumentStore` — `remote` storage mode
 * (docs/cloud-backend-auth.md, "Document storage modes").
 *
 * The server is the only persistent copy: open downloads the bytes into
 * memory, save uploads them, and nothing is written to disk outside the
 * ephemeral {@link ScratchSpace} (engines/sidecars/PDF paths that need a
 * real file get one there; tracked, wiped by `cleanupAll()`, wiped on exit
 * once the main process wires the hook). Crash-recovery autosave targeting
 * the server is the per-mode-autosave task; until then `writeRecovery`
 * buffers into the same tracked scratch space, so no copy survives a clean
 * exit either way.
 *
 * Electron-free by injection, exactly like the remote project adapter: the
 * transport is a `(path, init) => Response` seam that already carries the
 * base URL and authentication (the shell's backend client — Bearer attach +
 * refresh-once-on-401); `baseUrlTransport` builds that seam from a bare
 * fetch when a base URL is the input at hand. No URL, token, or Electron
 * import appears here.
 *
 * ## Wire contract (services/backend/src/routes/documents.ts)
 *
 * - `GET /documents` → `{documents: […]}` metadata, oldest first — the only
 *   metadata surface, so `exists`/`stat`/`changedExternally` read the list.
 * - `GET /documents/:id` → the current bytes with `ETag: <version>` (a bare
 *   integer, the same value `If-Match` accepts); parsed onto the ref.
 * - `POST /documents` (multipart `name` + `kind` fields + one `file` part) →
 *   creates version 1, answers the record.
 * - `PUT /documents/:id` (multipart file part; `If-Match: <version>` when
 *   the ref carries one) → appends a version; a stale guard is 409.
 * - `PUT /documents/:id?conflict=copy` → stores the upload as a NEW
 *   document (fresh id, version 1), original untouched — see below.
 * - `DELETE /documents/:id` (+ optional `If-Match`) → 204.
 *
 * ## Conflict policy (the design's resolution: conflict copies)
 *
 * A 409 never overwrites and never fails the save: the bytes are re-sent
 * with `?conflict=copy`, the ref is re-pointed at the new document, and
 * `conflicted` is set on it (plus the `onConflict` callback) so the caller
 * can surface that this document now lives beside a diverging copy. The
 * next save updates the copy — the local working file (hybrid) and the
 * previous server copy are both left exactly as they were.
 *
 * Mutations are serialized per document (one queue per cloud id), so this
 * client's own back-to-back saves chain versions instead of 409-ing each
 * other; only another device's write can produce a conflict.
 */

import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { DocumentRef, DocumentStat, DocumentStore, RecoveryStamp } from './types.js'
import { ScratchSpace } from './scratch.js'

// ────────────────────────────────────────────────────────────
// Transport + errors
// ────────────────────────────────────────────────────────────

/**
 * Authenticated transport seam. The shell passes its backend client's
 * `fetch` (base URL + Bearer + refresh-once-on-401); tests pass a fake
 * speaking the documents REST contract. Paths are relative
 * (`/documents/…`), never absolute URLs.
 */
export type DocumentTransport = (path: string, init?: RequestInit) => Promise<Response>

/**
 * Build the transport seam from a base URL and a bare fetch — the input the
 * adapter takes when no backend client carries the URL yet. The base path
 * prefix is kept and trailing slashes collapse, exactly like the backend
 * client's own URL join.
 */
export function baseUrlTransport(
  baseUrl: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): DocumentTransport {
  const base = new URL(baseUrl)
  const prefix = `${base.origin}${base.pathname.replace(/\/+$/, '')}`
  return (path, init) => fetchFn(`${prefix}/${path.replace(/^\/+/, '')}`, init)
}

/** Stable error kind — the routing layer branches on it. */
export type RemoteDocumentErrorCode = 'not_found' | 'conflict' | 'unavailable' | 'http_error'

/** Base class: every failure of the remote adapter is one of these four. */
export class RemoteDocumentError extends Error {
  readonly code: RemoteDocumentErrorCode
  /** HTTP status when the server answered (`undefined` for transport failures). */
  readonly status: number | undefined

  constructor(message: string, options: { code: RemoteDocumentErrorCode; status?: number }) {
    super(message)
    this.name = this.constructor.name
    this.code = options.code
    this.status = options.status
  }
}

/**
 * The server has no such document (404, or the ref carries no cloud id yet).
 * The local adapter's analogue is `ENOENT` from `read`/`stat`.
 */
export class RemoteDocumentNotFoundError extends RemoteDocumentError {
  constructor(message = 'no such document on the server') {
    super(message, { code: 'not_found', status: 404 })
  }
}

/**
 * 409 `version_conflict` that survived resolution: another writer's version
 * is stored and the conflict copy itself could not be uploaded (or a
 * version-guarded delete raced). No merge happens; the caller decides.
 */
export class RemoteDocumentConflictError extends RemoteDocumentError {
  constructor(message = 'the document changed on the server since it was read') {
    super(message, { code: 'conflict', status: 409 })
  }
}

/**
 * The backend could not be used: transport failure, 5xx, or a dead session
 * (a 401 that survived the transport's refresh-once). In hybrid mode this
 * is exactly the failure the mirror isolates; in remote mode it fails the
 * save outright — there is no local copy to fall back on.
 */
export class RemoteDocumentUnavailableError extends RemoteDocumentError {
  constructor(message = 'the cloud backend is unreachable', options?: { status?: number }) {
    super(message, { code: 'unavailable', status: options?.status })
  }
}

/** Any other definitive server rejection (400, 413, …) — surfaced, never a fallback. */
export class RemoteDocumentApiError extends RemoteDocumentError {
  constructor(message: string, options: { status: number }) {
    super(message, { code: 'http_error', status: options.status })
  }
}

// ────────────────────────────────────────────────────────────
// Wire shapes (mirror services/backend/src/storage/store.ts)
// ────────────────────────────────────────────────────────────

/** `GET /documents` item. */
interface WireDocumentSummary {
  id: string
  name: string
  kind: string
  size: number
  currentVersion: number
  createdAt: string
  updatedAt: string
}

/** `POST/PUT /documents…` full record (adds the current sha256). */
interface WireDocumentRecord extends WireDocumentSummary {
  sha256: string
}

/** The uniform backend error envelope. */
interface WireErrorEnvelope {
  error: { code: string; message: string }
}

/** Document kinds the API accepts (services/backend DOCUMENT_KINDS). */
export type RemoteDocumentKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'md' | 'html'

/** Extension → wire kind; unknown extensions upload as the pilot's format. */
const KIND_BY_EXTENSION: Readonly<Record<string, RemoteDocumentKind>> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.pdf': 'pdf',
  '.md': 'md',
  '.markdown': 'md',
  '.html': 'html',
  '.htm': 'html',
}

/** Server name cap (NAME_MAX_LENGTH in the documents route). */
const NAME_MAX_LENGTH = 255

function kindForPath(path: string): RemoteDocumentKind {
  const dot = path.lastIndexOf('.')
  const kind = dot < 0 ? undefined : KIND_BY_EXTENSION[path.slice(dot).toLowerCase()]
  return kind ?? 'docx'
}

/** The upload's document name: the ref's file name, capped to the wire limit. */
function nameForPath(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'document'
  const name = base.slice(0, NAME_MAX_LENGTH).trim()
  return name === '' ? 'document' : name
}

// ────────────────────────────────────────────────────────────
// Multipart encoding (the API's primary upload shape)
// ────────────────────────────────────────────────────────────

/** One form part: a field (`value`) or the single file part (`bytes`). */
interface MultipartPart {
  name: string
  value?: string
  filename?: string
  bytes?: Buffer
}

/** Keep quote/backslash/newline out of a disposition token (RFC 7578 §2). */
function dispositionToken(value: string): string {
  return value.replace(/["\\\r\n]/g, '_')
}

/**
 * Hand-rolled `multipart/form-data` body (fields + one file part), so the
 * exact bytes and boundary are inspectable and no FormData/Blob runtime
 * support is assumed on the transport's side of the seam. The boundary is
 * 128 random bits — the odds of it occurring inside document bytes (zip
 * containers by then) are beyond negligible, the same assumption every
 * multipart encoder ships with.
 */
function buildMultipartBody(parts: readonly MultipartPart[]): {
  contentType: string
  body: ArrayBuffer
} {
  const boundary = `----genoffice-docstore-${randomBytes(16).toString('hex')}`
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'))
    const name = dispositionToken(part.name)
    const filename =
      part.filename === undefined ? '' : `; filename="${dispositionToken(part.filename)}"`
    chunks.push(
      Buffer.from(`content-disposition: form-data; name="${name}"${filename}\r\n`, 'utf8'),
    )
    if (part.bytes !== undefined) {
      chunks.push(Buffer.from('content-type: application/octet-stream\r\n', 'utf8'))
    }
    chunks.push(Buffer.from('\r\n', 'utf8'))
    chunks.push(part.bytes ?? Buffer.from(part.value ?? '', 'utf8'))
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  const bytes = Buffer.concat(chunks)
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    // fetch bodies want an ArrayBuffer-backed view; a subarray of a shared
    // buffer is copied (same conversion the ai-provider fetch callers use)
    body: toArrayBuffer(bytes),
  }
}

/** Blob/fetch bodies want an ArrayBuffer-backed view; a subarray of a shared buffer is copied */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** The `POST`/`PUT` body: metadata fields (when asked for) + the file part. */
function buildUpload(
  bytes: Buffer,
  fileName: string,
  metadata: { name: string; kind: RemoteDocumentKind } | undefined,
): { contentType: string; body: ArrayBuffer } {
  const parts: MultipartPart[] = []
  if (metadata !== undefined) {
    parts.push({ name: 'name', value: metadata.name })
    parts.push({ name: 'kind', value: metadata.kind })
  }
  parts.push({ name: 'file', filename: fileName, bytes })
  return buildMultipartBody(parts)
}

/** A surfaced conflict: the save landed as a new copy beside a diverging original. */
export interface DocumentConflictEvent {
  /** The ref's path (the caller's key for surfacing). */
  path: string
  /** The cloud id the save targeted — still intact server-side, now diverging. */
  previousCloudId: string
  /** The conflict copy's cloud id; the ref points at it from here on. */
  cloudId: string
  /** The conflict copy's version (1 — a fresh version chain). */
  version: number
}

export interface RemoteDocumentStoreOptions {
  /** authenticated transport (the shell's backend client fetch) */
  transport: DocumentTransport
  /**
   * Directory for the ephemeral scratch files (an injected temp dir — a
   * `userData`-adjacent path on the Electron side). Nothing else is ever
   * written to disk.
   */
  tempDir: string
  /** Push notification for the conflict policy: a save landed as a copy. */
  onConflict?: (conflict: DocumentConflictEvent) => void
}

// ────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────

export class RemoteDocumentStore implements DocumentStore {
  private readonly transport: DocumentTransport
  readonly scratch: ScratchSpace
  private readonly onConflict: ((conflict: DocumentConflictEvent) => void) | undefined

  /** per-owner document keys writable via a plain save */
  private readonly writableKeys = new Map<number, Set<string>>()
  /** per-owner server version recorded at the last read/write */
  private readonly seenVersions = new Map<number, Map<string, number>>()
  /** per-document clock of the last download/upload (the recovery stamp's "document" side) */
  private readonly syncClocks = new Map<string, number>()
  /** recovery-buffer clear epochs (the stale-write race guard, as in the local store) */
  private readonly recoveryClearEpochs = new Map<string, number>()
  /** one mutation queue per document: this client's saves chain versions, they never 409 each other */
  private readonly mutationQueues = new Map<string, Promise<undefined>>()

  constructor(options: RemoteDocumentStoreOptions) {
    this.transport = options.transport
    this.scratch = new ScratchSpace(options.tempDir)
    this.onConflict = options.onConflict
  }

  /** The server-side key of a ref: the cloud id once assigned, the path until then. */
  private key(ref: DocumentRef): string {
    return ref.cloudId ?? ref.path
  }

  /** Serializes one document's mutations through a single queue. */
  private enqueue<T>(ref: DocumentRef, run: () => Promise<T>): Promise<T> {
    const key = this.key(ref)
    const previous = this.mutationQueues.get(key) ?? Promise.resolve(undefined)
    const next = previous.then(run, run)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    this.mutationQueues.set(key, tail)
    void tail.then(() => {
      if (this.mutationQueues.get(key) === tail) this.mutationQueues.delete(key)
    })
    return next
  }

  // ── transport helpers ─────────────────────────────────────

  /** One request, with the unavailable/auth classifications applied. */
  private async send(path: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await this.transport(path, init)
    } catch (error) {
      throw new RemoteDocumentUnavailableError(
        `request to the cloud backend failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status === 401) {
      // the transport already refreshed once; a second 401 is a dead session
      throw new RemoteDocumentUnavailableError('the cloud session is no longer valid', {
        status: 401,
      })
    }
    if (response.status >= 500) {
      throw new RemoteDocumentUnavailableError(`the cloud backend answered ${response.status}`, {
        status: response.status,
      })
    }
    return response
  }

  /** Turns a definitive rejection into its typed error (envelope code kept). */
  private async fail(response: Response): Promise<never> {
    if (response.status === 404) throw new RemoteDocumentNotFoundError()
    if (response.status === 409) throw new RemoteDocumentConflictError()
    let code = ''
    try {
      const envelope = (await response.json()) as Partial<WireErrorEnvelope>
      if (envelope && typeof envelope.error === 'object') code = envelope.error.code ?? ''
    } catch {
      // an unreadable body still classifies by status alone
    }
    throw new RemoteDocumentApiError(
      `the cloud backend rejected the request${code ? ` (${code})` : ''}`,
      { status: response.status },
    )
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch (error) {
      throw new RemoteDocumentUnavailableError(
        `the cloud backend sent an unreadable body: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** The document list (oldest first), keyed by id — the metadata surface. */
  private async listByKey(): Promise<Map<string, WireDocumentSummary>> {
    const response = await this.send('/documents', { method: 'GET' })
    if (!response.ok) throw await this.fail(response)
    const parsed = (await this.json(response)) as { documents?: unknown }
    const documents = Array.isArray(parsed?.documents) ? parsed.documents : []
    const byId = new Map<string, WireDocumentSummary>()
    for (const item of documents) {
      const summary = item as Partial<WireDocumentSummary>
      if (typeof summary.id === 'string' && summary.id !== '')
        byId.set(summary.id, {
          id: summary.id,
          name: typeof summary.name === 'string' ? summary.name : '',
          kind: typeof summary.kind === 'string' ? summary.kind : '',
          size: typeof summary.size === 'number' ? summary.size : 0,
          currentVersion: typeof summary.currentVersion === 'number' ? summary.currentVersion : 0,
          createdAt: typeof summary.createdAt === 'string' ? summary.createdAt : '',
          updatedAt: typeof summary.updatedAt === 'string' ? summary.updatedAt : '',
        })
    }
    return byId
  }

  /** The record behind a create/update reply (id + version are load-bearing). */
  private async recordOf(response: Response): Promise<WireDocumentRecord> {
    const parsed = (await this.json(response)) as unknown
    const record = (parsed ?? {}) as Partial<WireDocumentRecord>
    if (typeof record.id !== 'string' || record.id === '') {
      throw new RemoteDocumentUnavailableError('the cloud backend sent no document id')
    }
    if (typeof record.currentVersion !== 'number' || !Number.isFinite(record.currentVersion)) {
      throw new RemoteDocumentUnavailableError('the cloud backend sent no document version')
    }
    return record as WireDocumentRecord
  }

  /** Records the freshly assigned identity onto the ref. */
  private adopt(ref: DocumentRef, record: WireDocumentRecord): void {
    ref.cloudId = record.id
    ref.version = record.currentVersion
    this.syncClocks.set(this.key(ref), Date.now())
  }

  // ── uploads ───────────────────────────────────────────────

  /** `POST /documents` — first mirror of a document with no cloud id yet. */
  private async create(ref: DocumentRef, bytes: Buffer): Promise<void> {
    const name = nameForPath(ref.path)
    const { contentType, body } = buildUpload(bytes, name, { name, kind: kindForPath(ref.path) })
    const response = await this.send('/documents', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    })
    if (!response.ok) throw await this.fail(response)
    this.adopt(ref, await this.recordOf(response))
  }

  /**
   * `PUT /documents/:id` — append a version, guarded by the ref's version
   * (`?conflict=copy` stores the bytes as a NEW document instead).
   */
  private async update(
    ref: DocumentRef,
    bytes: Buffer,
    conflictCopy: boolean,
  ): Promise<WireDocumentRecord> {
    // an update keeps the server's stored name/kind; only a conflict copy
    // must carry a name (the server appends its "(conflict …)" suffix)
    const metadata = conflictCopy
      ? { name: nameForPath(ref.path), kind: kindForPath(ref.path) }
      : undefined
    const { contentType, body } = buildUpload(bytes, nameForPath(ref.path), metadata)
    const path = `/documents/${encodeURIComponent(ref.cloudId as string)}${
      conflictCopy ? '?conflict=copy' : ''
    }`
    const response = await this.send(path, {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        ...(conflictCopy || ref.version === undefined ? {} : { 'if-match': String(ref.version) }),
      },
      body,
    })
    if (!response.ok) throw await this.fail(response)
    return await this.recordOf(response)
  }

  /** One save: create, or update with the conflict policy applied. */
  private async upload(ref: DocumentRef, bytes: Buffer): Promise<void> {
    if (ref.cloudId === undefined) {
      await this.create(ref, bytes)
      return
    }
    const previousCloudId = ref.cloudId
    try {
      this.adopt(ref, await this.update(ref, bytes, false))
      // the clean save clears the flag (a failed save leaves it as it was)
      ref.conflicted = false
      return
    } catch (error) {
      if (error instanceof RemoteDocumentConflictError) {
        // the design's resolution: never overwrite — store these bytes as a
        // new copy beside the diverging original, then follow the copy.
        const record = await this.update(ref, bytes, true)
        this.adopt(ref, record)
        ref.conflicted = true
        this.onConflict?.({
          path: ref.path,
          previousCloudId,
          cloudId: record.id,
          version: record.currentVersion,
        })
        return
      }
      if (error instanceof RemoteDocumentNotFoundError) {
        // the server copy vanished (deleted from another device, data reset):
        // recreate the mirror rather than failing every later save — the
        // same self-healing the remote project adapter applies to a vanished
        // chat row. No user data is merged; a fresh chain starts.
        ref.cloudId = undefined
        await this.create(ref, bytes)
        return
      }
      throw error
    }
  }

  // ── stored bytes ──────────────────────────────────────────

  async exists(ref: DocumentRef): Promise<boolean> {
    if (ref.cloudId === undefined) return false // never created: nothing is stored
    return (await this.listByKey()).has(ref.cloudId)
  }

  async stat(ref: DocumentRef): Promise<DocumentStat> {
    if (ref.cloudId === undefined) throw new RemoteDocumentNotFoundError()
    const summary = (await this.listByKey()).get(ref.cloudId)
    if (summary === undefined) throw new RemoteDocumentNotFoundError()
    const mtimeMs = Date.parse(summary.updatedAt)
    return { mtimeMs: Number.isNaN(mtimeMs) ? 0 : mtimeMs, size: summary.size }
  }

  async read(ref: DocumentRef): Promise<Buffer> {
    if (ref.cloudId === undefined) throw new RemoteDocumentNotFoundError()
    const response = await this.send(`/documents/${encodeURIComponent(ref.cloudId)}`, {
      method: 'GET',
    })
    if (!response.ok) throw await this.fail(response)
    // the download's ETag is the bare version integer — the next save's guard
    const etag = response.headers.get('etag')
    if (etag !== null && /^\d+$/.test(etag)) ref.version = Number(etag)
    this.syncClocks.set(this.key(ref), Date.now())
    return Buffer.from(await response.arrayBuffer())
  }

  async write(ref: DocumentRef, bytes: Buffer): Promise<void> {
    await this.enqueue(ref, () => this.upload(ref, bytes))
  }

  async remove(ref: DocumentRef): Promise<void> {
    await this.enqueue(ref, () => this.delete(ref))
  }

  /** `DELETE /documents/:id` — best-effort, like the local store's unlink. */
  private async delete(ref: DocumentRef): Promise<void> {
    if (ref.cloudId === undefined) return // never created: nothing to remove
    const path = `/documents/${encodeURIComponent(ref.cloudId)}`
    const send = (guarded: boolean): Promise<Response> =>
      this.send(path, {
        method: 'DELETE',
        headers: guarded && ref.version !== undefined ? { 'if-match': String(ref.version) } : {},
      })
    let response = await send(true)
    if (response.status === 404) return // already gone: the rollback has nothing to undo
    if (response.status === 409) {
      // the guard raced a concurrent upload; deleting the document at all is
      // the caller's rollback decision, so finish it unguarded
      response = await send(false)
      if (response.status === 404) return
    }
    if (!response.ok) throw await this.fail(response)
  }

  async ensureFolder(_ref: DocumentRef): Promise<void> {
    /* the server has no folders; the ref's path is only a label here */
  }

  hashBytes(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex')
  }

  /**
   * No server-side name registry exists yet, so there is nothing to dodge:
   * the first free name is the name. Cloud-aware naming/dedupe lands with
   * the cloud-identity task (server-side recents/starred, home cloud view).
   */
  uniquePathIn(dir: string, fileName: string): string {
    return join(dir, fileName)
  }

  // ── write grants (id-keyed; the path only stands in until creation) ────

  authorizeWrite(ownerId: number, ref: DocumentRef): void {
    const set = this.writableKeys.get(ownerId) ?? new Set<string>()
    set.add(this.key(ref))
    this.writableKeys.set(ownerId, set)
  }

  async canWrite(ownerId: number, ref: DocumentRef): Promise<boolean> {
    return this.writableKeys.get(ownerId)?.has(this.key(ref)) === true
  }

  /**
   * Local-only re-keying (see the interface): a rename changes no cloud id,
   * so only the path-stand-in keys move; a document that already has a cloud
   * id keeps its grant untouched.
   */
  renameOwnerPath(ownerId: number, oldPath: string, newPath: string): void {
    const set = this.writableKeys.get(ownerId)
    if (set === undefined) return
    if (set.delete(oldPath)) set.add(newPath)
  }

  forgetOwner(ownerId: number): void {
    this.writableKeys.delete(ownerId)
    this.seenVersions.delete(ownerId)
  }

  // ── external-change detection (server version checks) ─────

  /** Records the server version the owner last read/wrote (`hash` unused: the version is the baseline). */
  async recordDiskState(ownerId: number, ref: DocumentRef, _hash: string): Promise<void> {
    if (ref.cloudId === undefined || ref.version === undefined) return
    const versions = this.seenVersions.get(ownerId) ?? new Map<string, number>()
    versions.set(this.key(ref), ref.version)
    this.seenVersions.set(ownerId, versions)
  }

  /**
   * True when the server's current version is no longer the one this owner
   * last saw — another device uploaded. A vanished document is not a
   * conflict (the save recreates the mirror), mirroring the local rule that
   * an externally deleted file is not a conflict.
   */
  async changedExternally(ownerId: number, ref: DocumentRef): Promise<boolean> {
    const recorded = this.seenVersions.get(ownerId)?.get(this.key(ref))
    if (recorded === undefined || ref.cloudId === undefined) return false
    const summary = (await this.listByKey()).get(ref.cloudId)
    if (summary === undefined) return false
    return summary.currentVersion !== recorded
  }

  // ── originals archive ─────────────────────────────────────

  /**
   * No-op: the server already keeps the version history the archive exists
   * to protect (every uploaded version stays downloadable), and remote mode
   * keeps no persistent local copy to archive into.
   */
  async archiveOriginal(_ref: DocumentRef, _hash: string, _size: number): Promise<void> {
    /* the server's version history is the original's safety net here */
  }

  // ── crash-recovery copies (ephemeral scratch buffer) ──────

  /**
   * The recovery key: the document's server key under a `recovery-` prefix —
   * deterministic, so the sweep can derive every owner-writable document's
   * buffer from its key alone (a scratch file written while the ref still
   * carried only a path keeps that path-keyed name; it stays tracked and is
   * wiped with the rest of the scratch space on cleanup/exit).
   */
  private recoveryKey(ref: DocumentRef): string {
    return `recovery-${this.key(ref)}`
  }

  private recoveryPath(ref: DocumentRef): string {
    return this.scratch.stablePathFor(this.recoveryKey(ref))
  }

  async writeRecovery(ref: DocumentRef, bytes: Buffer): Promise<void> {
    await this.scratch.writeAt(this.recoveryPath(ref), bytes)
  }

  /**
   * The buffer's stamp against the last server sync (the remote stand-in for
   * the local copy-vs-document mtime pair): a newer buffer means unsaved
   * edits to offer. Null when no buffer exists.
   */
  recoveryStamp(ref: DocumentRef): RecoveryStamp | null {
    const recoveryMtimeMs = this.scratch.mtimeMsOf(this.recoveryPath(ref))
    if (recoveryMtimeMs === null) return null
    return {
      recoveryMtimeMs,
      documentMtimeMs: this.syncClocks.get(this.key(ref)) ?? 0,
    }
  }

  async readRecovery(ref: DocumentRef): Promise<Buffer | null> {
    return this.scratch.read(this.recoveryPath(ref))
  }

  recoveryEpoch(ref: DocumentRef): number {
    return this.recoveryClearEpochs.get(this.recoveryKey(ref)) ?? 0
  }

  clearRecovery(ref: DocumentRef): void {
    this.clearRecoveryKey(this.recoveryKey(ref))
  }

  private clearRecoveryKey(key: string): void {
    this.recoveryClearEpochs.set(key, (this.recoveryClearEpochs.get(key) ?? 0) + 1)
    this.scratch.remove(this.scratch.stablePathFor(key))
  }

  sweepRecoveryCopies(ownerId: number): void {
    for (const key of this.writableKeys.get(ownerId) ?? []) {
      this.clearRecoveryKey(`recovery-${key}`)
    }
  }
}
