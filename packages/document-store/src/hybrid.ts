/**
 * Hybrid `DocumentStore` — `hybrid` storage mode
 * (docs/cloud-backend-auth.md, "Document storage modes").
 *
 * The local file stays the working copy (local semantics: atomic writes,
 * write grants, external-change detection, originals archive, recovery
 * copies — every op delegates to the local half), and every successful
 * local save is mirrored to the server through the remote half
 * (upload-on-save; the first mirror of a local-only document creates the
 * cloud document). Opening a cloud document downloads it to the local file
 * (`read` on a missing local copy fetches and lands it). There is no
 * background sync daemon — a save is a save, and its mirror rides along.
 *
 * ## Mirror isolation (the design's "mirror, not transactional")
 *
 * A failed upload never fails the local save: it is recorded in
 * `pendingUploads` (and pushed through `onPendingUpload`) for the caller to
 * surface, and the next successful save of the same document drops the
 * entry. The mirror is retried by the next save, not by a daemon.
 *
 * ## Conflict policy
 *
 * The remote half owns it: an upload that hits a stale `If-Match` is
 * re-sent with `?conflict=copy`, so the server's copy is never overwritten
 * and the ref ends up pointing at the new copy with `conflicted` set (the
 * local file's bytes are untouched — they are the working copy). Conflict
 * events come from the remote half's own `onConflict` callback; this class
 * surfaces the per-document flag on the ref.
 */

import type { DocumentRef, DocumentStat, DocumentStore, RecoveryStamp } from './types.js'
import { RemoteDocumentStore } from './remote.js'

/** One mirror attempt that did not land (surfaced, never thrown). */
export interface PendingDocumentUpload {
  /** The working copy's path (the caller's key for surfacing). */
  path: string
  /** The cloud id the mirror targeted, once the document has one. */
  cloudId: string | undefined
  /** Why the mirror failed (a `RemoteDocumentError`, or a transport failure). */
  error: unknown
  /** When the failed mirror was recorded (UTC ms). */
  atMs: number
}

export interface HybridDocumentStoreOptions {
  /** Push notification for every recorded pending upload. */
  onPendingUpload?: (pending: PendingDocumentUpload) => void
}

export class HybridDocumentStore implements DocumentStore {
  private readonly local: DocumentStore
  private readonly remote: RemoteDocumentStore
  private readonly onPendingUpload: ((pending: PendingDocumentUpload) => void) | undefined
  private pending: PendingDocumentUpload[] = []

  constructor(
    local: DocumentStore,
    remote: RemoteDocumentStore,
    options: HybridDocumentStoreOptions = {},
  ) {
    this.local = local
    this.remote = remote
    this.onPendingUpload = options.onPendingUpload
  }

  /** The remote half (its scratch space and conflict callback are the caller's to wire). */
  get remoteStore(): RemoteDocumentStore {
    return this.remote
  }

  /** Mirror attempts that have not landed yet, oldest first. */
  get pendingUploads(): readonly PendingDocumentUpload[] {
    return this.pending
  }

  /** Drop every pending-upload record (the caller has surfaced them). */
  clearPendingUploads(): void {
    this.pending = []
  }

  /** A failed mirror is recorded, never thrown — the local save already landed. */
  private async mirror(ref: DocumentRef, bytes: Buffer): Promise<void> {
    try {
      await this.remote.write(ref, bytes)
      // the mirror caught up: stale failures for this document are resolved
      this.pending = this.pending.filter((entry) => entry.path !== ref.path)
    } catch (error) {
      const pending: PendingDocumentUpload = {
        path: ref.path,
        cloudId: ref.cloudId,
        error,
        atMs: Date.now(),
      }
      this.pending = [...this.pending, pending]
      this.onPendingUpload?.(pending)
    }
  }

  // ── stored bytes ──────────────────────────────────────────

  /** True when the working copy is on disk or the server still has the document. */
  async exists(ref: DocumentRef): Promise<boolean> {
    if (await this.local.exists(ref)) return true
    return this.remote.exists(ref)
  }

  async stat(ref: DocumentRef): Promise<DocumentStat> {
    try {
      return await this.local.stat(ref)
    } catch (error) {
      // an unstatable working copy falls back to the server's metadata only
      // when the cause is a missing file (the local contract rejects ENOENT)
      if (!isMissing(error) || ref.cloudId === undefined) throw error
      return this.remote.stat(ref)
    }
  }

  async read(ref: DocumentRef): Promise<Buffer> {
    if (await this.local.exists(ref)) return this.local.read(ref)
    if (ref.cloudId === undefined) {
      // no working copy and no cloud document: the local read rejects ENOENT
      return this.local.read(ref)
    }
    // opening a cloud document downloads it to a local file
    const bytes = await this.remote.read(ref)
    await this.local.ensureFolder(ref)
    await this.local.write(ref, bytes)
    return bytes
  }

  /** The local save, then its mirror (isolated: an upload failure is recorded, not thrown). */
  async write(ref: DocumentRef, bytes: Buffer): Promise<void> {
    await this.local.write(ref, bytes)
    await this.mirror(ref, bytes)
  }

  /**
   * Local only, deliberately: this is the rollback of a file this process
   * just created, and the design mirrors saves — server-side deletion (and
   * what a mode switch does with the server copy) is the identity/migration
   * work, not a save path.
   */
  async remove(ref: DocumentRef): Promise<void> {
    await this.local.remove(ref)
  }

  async ensureFolder(ref: DocumentRef): Promise<void> {
    await this.local.ensureFolder(ref)
  }

  hashBytes(bytes: Buffer): string {
    return this.local.hashBytes(bytes)
  }

  uniquePathIn(dir: string, fileName: string): string {
    return this.local.uniquePathIn(dir, fileName)
  }

  // ── write grants / external-change detection: the working copy's rules ──

  authorizeWrite(ownerId: number, ref: DocumentRef): void {
    this.local.authorizeWrite(ownerId, ref)
  }

  async canWrite(ownerId: number, ref: DocumentRef): Promise<boolean> {
    return this.local.canWrite(ownerId, ref)
  }

  renameOwnerPath(ownerId: number, oldPath: string, newPath: string): void {
    this.local.renameOwnerPath(ownerId, oldPath, newPath)
  }

  forgetOwner(ownerId: number): void {
    this.local.forgetOwner(ownerId)
  }

  async recordDiskState(ownerId: number, ref: DocumentRef, hash: string): Promise<void> {
    await this.local.recordDiskState(ownerId, ref, hash)
  }

  async changedExternally(ownerId: number, ref: DocumentRef): Promise<boolean> {
    return this.local.changedExternally(ownerId, ref)
  }

  // ── originals archive / crash-recovery copies: local semantics ──────────

  async archiveOriginal(ref: DocumentRef, hash: string, size: number): Promise<void> {
    await this.local.archiveOriginal(ref, hash, size)
  }

  async writeRecovery(ref: DocumentRef, bytes: Buffer): Promise<void> {
    await this.local.writeRecovery(ref, bytes)
  }

  recoveryStamp(ref: DocumentRef): RecoveryStamp | null {
    return this.local.recoveryStamp(ref)
  }

  async readRecovery(ref: DocumentRef): Promise<Buffer | null> {
    return this.local.readRecovery(ref)
  }

  recoveryEpoch(ref: DocumentRef): number {
    return this.local.recoveryEpoch(ref)
  }

  clearRecovery(ref: DocumentRef): void {
    this.local.clearRecovery(ref)
  }

  sweepRecoveryCopies(ownerId: number): void {
    this.local.sweepRecoveryCopies(ownerId)
  }
}

/** The local contract's "no such file" (the remote half has its own typed not-found). */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
