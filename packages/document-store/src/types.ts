/**
 * document-store type definitions: the seam the editors' save/open handlers
 * route through (docs/cloud-backend-auth.md, "Document storage modes" —
 * "Save/open routing"). Extracted from what the docs editor's handlers
 * actually do, not invented: every member below has a call site today.
 */

/**
 * Identity of a stored document. Path-keyed for the local adapter; a
 * server-assigned cloud document id is the planned addition for the
 * remote/hybrid adapters (a later task) — ops keep this shape, so the ref
 * grows a field instead of the call sites reshaping.
 */
export interface DocumentRef {
  /** Absolute path of the document file (the only key today). */
  path: string
}

/** Cheap metadata of the stored bytes (size caps, external-change checks). */
export interface DocumentStat {
  mtimeMs: number
  size: number
}

/**
 * Disk snapshot recorded at the last read/write of a document path, so a
 * later save can refuse to clobber edits made by another program.
 */
export interface DiskFileState {
  mtimeMs: number
  size: number
  hash: string
}

/**
 * Open-time recovery probe: modification times of the crash-recovery copy
 * and of the document it belongs to. `null` when no copy exists.
 */
export interface RecoveryStamp {
  recoveryMtimeMs: number
  documentMtimeMs: number
}

/**
 * Document storage API. The async members are the remote-capable core
 * (open/save/stat/delete — a remote adapter downloads/uploads behind them);
 * the sync members are session-local bookkeeping (write grants, rename and
 * teardown re-keying, recovery epochs) that a remote adapter keeps in front
 * of its core or replaces with id-based equivalents.
 *
 * `ownerId` is the id of the editing surface (a webContents id in the docs
 * pilot): grants and recorded disk states are per-owner, so a closed tab
 * loses exactly its own.
 */
export interface DocumentStore {
  // ── stored bytes ────────────────────────────────────────────────────────

  /** True when the target exists (`existsSync` semantics: false when unreadable). */
  exists(ref: DocumentRef): Promise<boolean>

  /** Metadata of the stored bytes; rejects like `fs.stat`. */
  stat(ref: DocumentRef): Promise<DocumentStat>

  /** The stored bytes; rejects like `fs.readFile`. */
  read(ref: DocumentRef): Promise<Buffer>

  /**
   * Replace the stored bytes atomically (same-dir temp file + rename, with the
   * Windows transient-lock retry and in-place fallback), so a crash mid-write
   * can't truncate the target.
   */
  write(ref: DocumentRef, bytes: Buffer): Promise<void>

  /** Best-effort delete (rollback of a file this process just created). */
  remove(ref: DocumentRef): Promise<void>

  /** Create the document's folder if missing (`docs:save-to` targets caller-chosen dirs). */
  ensureFolder(ref: DocumentRef): Promise<void>

  /** Document identity of the bytes (sha256 hex) for archives and conflict checks. */
  hashBytes(bytes: Buffer): string

  /** First free path for `fileName` inside `dir`: name.ext, name-2.ext, name-3.ext… */
  uniquePathIn(dir: string, fileName: string): string

  // ── write grants (path-keyed today; id-based equivalents later) ─────────

  /** Grant an owner write access (document opened, save-as landed, MCP target resolved). */
  authorizeWrite(ownerId: number, ref: DocumentRef): void

  /** May this owner write the document? (guards docs:save / write-recovery / save-to) */
  canWrite(ownerId: number, ref: DocumentRef): Promise<boolean>

  /**
   * Re-key an owner's grant and recorded disk state after the file was renamed
   * or moved on disk, so the next save accepts the new path and keeps its
   * external-change baseline.
   */
  renameOwnerPath(ownerId: number, oldPath: string, newPath: string): void

  /** Drop every grant and recorded disk state for an owner (window closed). */
  forgetOwner(ownerId: number): void

  // ── external-change detection ───────────────────────────────────────────

  /**
   * Record the state an owner last read/wrote (called right after every open
   * and save). An unstatable target is skipped: the next save simply won't
   * flag a conflict.
   */
  recordDiskState(ownerId: number, ref: DocumentRef, hash: string): Promise<void>

  /**
   * True when the file on disk no longer matches the recorded state, i.e.
   * another program wrote it since the last read/save. No record (path never
   * tracked) or a missing file (deleted externally) is not a conflict — the
   * save proceeds and recreates the file.
   */
  changedExternally(ownerId: number, ref: DocumentRef): Promise<boolean>

  // ── originals archive (pass-through base: the on-disk original kept by hash) ──

  /**
   * Archive a copy of the on-disk original under its content hash, so a bad
   * save never loses the source file. Oversized documents are skipped and the
   * archive is pruned to its size cap in the background.
   */
  archiveOriginal(ref: DocumentRef, hash: string, size: number): Promise<void>

  // ── crash-recovery copies ───────────────────────────────────────────────

  /** Write a recovery copy for the document (atomic, into the recovery dir). */
  writeRecovery(ref: DocumentRef, bytes: Buffer): Promise<void>

  /**
   * Modification times of the recovery copy vs the document, or null when no
   * copy exists. Sync on purpose: both stats belong to one tick, exactly as
   * the pre-extraction open path read them; throws like `statSync`.
   */
  recoveryStamp(ref: DocumentRef): RecoveryStamp | null

  /** Recovery-copy bytes, or null when unreadable (the open falls back to the original). */
  readRecovery(ref: DocumentRef): Promise<Buffer | null>

  /**
   * Current clear-epoch of the document's recovery copy. `docs:write-recovery`
   * snapshots it before its first await and discards its own result when a
   * save or discard bumped it mid-flight (stale-recovery race).
   */
  recoveryEpoch(ref: DocumentRef): number

  /** Delete the recovery copy (if any) and bump its clear-epoch. */
  clearRecovery(ref: DocumentRef): void

  /**
   * Clear the recovery copies of every document an owner may write (a closed
   * tab's leftover copy would resurrect discarded content on the next open).
   */
  sweepRecoveryCopies(ownerId: number): void
}
