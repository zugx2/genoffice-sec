/**
 * Local `DocumentStore` — the filesystem semantics the docs editor's save/open
 * handlers had inlined before the abstraction existed, lifted verbatim:
 * realpath-free path-keyed storage, atomic writes, per-owner write grants,
 * mtime+size+hash external-change detection, the originals archive, and the
 * crash-recovery copies under `<rootDir>/docs-autosave`.
 *
 * Pure Node (no Electron): the editing app injects its user-data directory,
 * exactly like `LocalProjectApi` over `ProjectStore`.
 */

import { createHash } from 'node:crypto'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from './atomic.js'
import { isExternallyModified } from './external-change.js'
import type {
  DiskFileState,
  DocumentRef,
  DocumentStat,
  DocumentStore,
  RecoveryStamp,
} from './types.js'

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

const ORIGINALS_MAX_BYTES = 500 * 1024 * 1024

export class LocalDocumentStore implements DocumentStore {
  private readonly rootDir: string

  /** per-owner paths writable via a plain save — populated by open/save-as flows */
  private readonly writablePaths = new Map<number, Set<string>>()
  /** per-owner disk state recorded at every read/write (external-change baseline) */
  private readonly diskStates = new Map<number, Map<string, DiskFileState>>()

  /** Bumped by every recovery clear: an in-flight recovery write that started
   *  before the bump must not recreate the file it is about to land. */
  private readonly recoveryClearEpochs = new Map<string, number>()

  private originalsPruneRunning = false

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  // ── stored bytes ────────────────────────────────────────────────────────

  async exists(ref: DocumentRef): Promise<boolean> {
    return existsSync(ref.path)
  }

  async stat(ref: DocumentRef): Promise<DocumentStat> {
    const s = await stat(ref.path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  }

  async read(ref: DocumentRef): Promise<Buffer> {
    return readFile(ref.path)
  }

  async write(ref: DocumentRef, bytes: Buffer): Promise<void> {
    await atomicWriteFile(ref.path, bytes)
  }

  async remove(ref: DocumentRef): Promise<void> {
    await unlink(ref.path).catch(() => {
      /* already gone: the rollback has nothing to undo */
    })
  }

  async ensureFolder(ref: DocumentRef): Promise<void> {
    await mkdir(dirname(ref.path), { recursive: true })
  }

  hashBytes(bytes: Buffer): string {
    return sha256Hex(bytes)
  }

  /** first free path for fileName inside dir: name.ext, name-2.ext, name-3.ext… */
  uniquePathIn(dir: string, fileName: string): string {
    const dot = fileName.lastIndexOf('.')
    const base = dot > 0 ? fileName.slice(0, dot) : fileName
    const ext = dot > 0 ? fileName.slice(dot) : ''
    let candidate = join(dir, fileName)
    for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${base}-${i}${ext}`)
    return candidate
  }

  // ── write grants ────────────────────────────────────────────────────────

  authorizeWrite(ownerId: number, ref: DocumentRef): void {
    const set = this.writablePaths.get(ownerId) ?? new Set<string>()
    set.add(ref.path)
    this.writablePaths.set(ownerId, set)
  }

  async canWrite(ownerId: number, ref: DocumentRef): Promise<boolean> {
    return this.writablePaths.get(ownerId)?.has(ref.path) === true
  }

  renameOwnerPath(ownerId: number, oldPath: string, newPath: string): void {
    // keep the save allowlist in sync so the next save accepts the renamed path
    this.writablePaths.get(ownerId)?.delete(oldPath)
    this.authorizeWrite(ownerId, { path: newPath })
    const states = this.diskStates.get(ownerId)
    const recorded = states?.get(oldPath)
    if (states && recorded) {
      states.delete(oldPath)
      states.set(newPath, recorded)
    }
  }

  forgetOwner(ownerId: number): void {
    this.writablePaths.delete(ownerId)
    this.diskStates.delete(ownerId)
  }

  // ── external-change detection ───────────────────────────────────────────

  async recordDiskState(ownerId: number, ref: DocumentRef, hash: string): Promise<void> {
    try {
      const s = await stat(ref.path)
      const states = this.diskStates.get(ownerId) ?? new Map<string, DiskFileState>()
      states.set(ref.path, { mtimeMs: s.mtimeMs, size: s.size, hash })
      this.diskStates.set(ownerId, states)
    } catch {
      /* unstatable target: skip tracking; the next save simply won't flag a conflict */
    }
  }

  async changedExternally(ownerId: number, ref: DocumentRef): Promise<boolean> {
    let current: DocumentStat | null
    try {
      current = await this.stat(ref)
    } catch {
      current = null
    }
    return isExternallyModified(this.diskStates.get(ownerId)?.get(ref.path), current, async () => {
      try {
        return sha256Hex(await readFile(ref.path))
      } catch {
        return null
      }
    })
  }

  // ── originals archive (pass-through base: original file archived by content hash) ──

  async archiveOriginal(ref: DocumentRef, hash: string, size: number): Promise<void> {
    // a copy larger than the whole cap would only evict every other original
    if (size > ORIGINALS_MAX_BYTES) return
    const dir = this.originalsDir()
    await mkdir(dir, { recursive: true })
    const target = join(dir, `${hash}.docx`)
    if (!existsSync(target)) await copyFile(ref.path, target)
    void this.pruneOriginals(dir)
  }

  private originalsDir(): string {
    return join(this.rootDir, 'originals')
  }

  /** cap the archive's total size; oldest by mtime go first (never blocks the open path) */
  private async pruneOriginals(dir: string): Promise<void> {
    if (this.originalsPruneRunning) return
    this.originalsPruneRunning = true
    try {
      const files: Array<{ path: string; size: number; mtimeMs: number }> = []
      for (const name of await readdir(dir)) {
        try {
          const s = await stat(join(dir, name))
          if (s.isFile()) files.push({ path: join(dir, name), size: s.size, mtimeMs: s.mtimeMs })
        } catch {
          /* removed concurrently */
        }
      }
      let total = files.reduce((sum, f) => sum + f.size, 0)
      files.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const f of files) {
        if (total <= ORIGINALS_MAX_BYTES) break
        try {
          await unlink(f.path)
          total -= f.size
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* directory unreadable: retry on the next archive */
    } finally {
      this.originalsPruneRunning = false
    }
  }

  // ── crash-recovery copies ───────────────────────────────────────────────

  private recoveryDir(): string {
    return join(this.rootDir, 'docs-autosave')
  }

  /** `<rootDir>/docs-autosave/<sha1(path)[0..16]>.docx` — the copy's stable name. */
  private recoveryPath(ref: DocumentRef): string {
    return join(
      this.recoveryDir(),
      `${createHash('sha1').update(ref.path).digest('hex').slice(0, 16)}.docx`,
    )
  }

  async writeRecovery(ref: DocumentRef, bytes: Buffer): Promise<void> {
    await mkdir(this.recoveryDir(), { recursive: true })
    await atomicWriteFile(this.recoveryPath(ref), bytes)
  }

  recoveryStamp(ref: DocumentRef): RecoveryStamp | null {
    const asPath = this.recoveryPath(ref)
    if (!existsSync(asPath)) return null
    return {
      recoveryMtimeMs: statSync(asPath).mtimeMs,
      documentMtimeMs: statSync(ref.path).mtimeMs,
    }
  }

  async readRecovery(ref: DocumentRef): Promise<Buffer | null> {
    try {
      return await readFile(this.recoveryPath(ref))
    } catch {
      return null
    }
  }

  recoveryEpoch(ref: DocumentRef): number {
    return this.recoveryClearEpochs.get(ref.path) ?? 0
  }

  clearRecovery(ref: DocumentRef): void {
    this.recoveryClearEpochs.set(ref.path, (this.recoveryClearEpochs.get(ref.path) ?? 0) + 1)
    try {
      unlinkSync(this.recoveryPath(ref))
    } catch {
      /* nothing to clean */
    }
  }

  sweepRecoveryCopies(ownerId: number): void {
    for (const p of this.writablePaths.get(ownerId) ?? []) this.clearRecovery({ path: p })
  }
}
