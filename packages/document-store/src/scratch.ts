/**
 * Ephemeral scratch files (docs/cloud-backend-auth.md, "Document storage
 * modes" — `remote`): some engines, sidecars, and PDF paths still need a
 * real file on disk to process a document, even when the authoritative copy
 * lives on the server. Every file this space hands out is tracked, lives
 * under the injected temp dir, and is deleted by `cleanupAll()` — nothing
 * here is a persistent local copy, and nothing survives a clean exit once
 * the exit wipe is wired (see `registerExitWipe`).
 *
 * Pure Node: the directory is injected (a `userData`-adjacent temp dir on
 * the Electron side) and the package never touches `process` itself — the
 * main process owns the lifecycle and registers the exit hook.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { atomicWriteFile } from './atomic.js'

/** Strip anything a path segment should not carry into a temp file name. */
function safeStem(label: string): string {
  const base = basename(label)
  const dot = base.lastIndexOf('.')
  const raw = (dot > 0 ? base.slice(0, dot) : base).replace(/[^\w.-]+/g, '_')
  return raw === '' || raw === '.' ? 'document' : raw
}

/** The label's extension (`.docx`, …), preserved for picky engines. */
function extensionOf(label: string): string {
  const base = basename(label)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

export class ScratchSpace {
  private readonly tempDir: string
  /** every scratch path this space created and has not deleted yet */
  private readonly trackedPaths = new Set<string>()

  constructor(tempDir: string) {
    this.tempDir = tempDir
  }

  /**
   * A fresh, unique scratch path for `label` (created lazily by `writeAt`;
   * engines that want to place their own file may use it directly — call
   * `track` so `cleanupAll` still covers it).
   */
  pathFor(label: string): string {
    return join(
      this.tempDir,
      `genoffice-${safeStem(label)}-${randomBytes(6).toString('hex')}${extensionOf(label)}`,
    )
  }

  /**
   * The deterministic scratch path for `label`: the same label always maps
   * to the same file (the crash-recovery buffer's stable name, mirroring the
   * local store's sha1-named recovery copies).
   */
  stablePathFor(label: string): string {
    const hash = createHash('sha1').update(label).digest('hex').slice(0, 16)
    return join(this.tempDir, `genoffice-${safeStem(label)}-${hash}${extensionOf(label)}`)
  }

  /** Write bytes to a scratch path atomically and start tracking it. */
  async writeAt(path: string, bytes: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await atomicWriteFile(path, bytes)
    this.track(path)
  }

  /** A new tracked scratch file holding `bytes`; resolves its path. */
  async write(label: string, bytes: Buffer): Promise<string> {
    const path = this.pathFor(label)
    await this.writeAt(path, bytes)
    return path
  }

  /** Cover a file this space did not write (engines placing their own). */
  track(path: string): void {
    this.trackedPaths.add(path)
  }

  /** Tracked scratch paths, oldest first (a stable order for surfacing). */
  tracked(): readonly string[] {
    return [...this.trackedPaths]
  }

  /** A scratch file's bytes, or null when it is gone/unreadable. */
  async read(path: string): Promise<Buffer | null> {
    try {
      return await readFile(path)
    } catch {
      return null
    }
  }

  /** A scratch file's mtime, or null when it is gone (`statSync` semantics). */
  mtimeMsOf(path: string): number | null {
    if (!existsSync(path)) return null
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  }

  /** Best-effort delete of one tracked scratch file. */
  remove(path: string): void {
    this.trackedPaths.delete(path)
    try {
      unlinkSync(path)
    } catch {
      /* already gone */
    }
  }

  /** Delete every tracked scratch file (best effort) and empty the set. */
  async cleanupAll(): Promise<void> {
    for (const path of [...this.trackedPaths]) this.remove(path)
  }

  /** Synchronous `cleanupAll` — the shape an exit hook needs. */
  cleanupAllSync(): void {
    for (const path of [...this.trackedPaths]) this.remove(path)
  }

  /**
   * Wire the wipe onto a process-exit hook. This package never touches
   * `process` (it stays Electron- and runtime-agnostic), so the main process
   * hands over the registration: `scratch.registerExitWipe((wipe) =>
   * process.on('exit', wipe))`. The wipe is the synchronous cleanup — an
   * exit path may not await.
   */
  registerExitWipe(onExit: (wipe: () => void) => void): void {
    onExit(() => this.cleanupAllSync())
  }
}
