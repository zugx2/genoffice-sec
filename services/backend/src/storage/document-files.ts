/**
 * File-byte storage for documents — the disk half of Phase 7a.
 *
 * The SQLite store (`store.ts`) keeps document metadata and version rows;
 * this module keeps the bytes, laid out
 * `<dataDir>/<urlencoded sub>/<documentId>/<version>` — never indexed by
 * filename. The `sub` level makes byte isolation structural, exactly like
 * the `WHERE sub = ?` in the store: one user's tree can never be addressed
 * through another's, and `encodeURIComponent` keeps a hostile `sub` from
 * escaping its directory (Keycloak sends UUIDs, so real paths stay flat).
 *
 * Ordering contract with the DB store (why writes stage before committing):
 *
 * 1. the version's bytes are streamed to a `.staging-*` file inside the
 *    document directory (never buffered in memory — a `Transform` counts
 *    bytes and hash as they pass, aborting with 413 the moment the cap is
 *    exceeded);
 * 2. the staging file is renamed to its final `<version>` name;
 * 3. only then does the caller insert/update the SQLite rows.
 *
 * A crash between (2) and (3) therefore orphans a file, never a row — an
 * orphan is inert, while a row without bytes would 500 on download. Pruned
 * and deleted files are removed after their rows are gone, so the same rule
 * holds for every cleanup path.
 *
 * Integrity: the sha256 recorded with a version is computed from the bytes
 * actually written (a client-supplied hash is never trusted), and re-checked
 * on every read; a mismatch surfaces as a typed {@link DocumentIntegrityError}
 * the route turns into a stable 500 (details logged server-side only).
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { payloadTooLarge } from '../errors.js'

/** Hard cap on one uploaded document version (brief ruling 4: 200 MiB, 413 over). */
export const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024

/** What a stored version looks like to the DB layer. */
export interface StoredBlob {
  /** Byte size as written to disk */
  readonly size: number
  /** sha256 hex digest of the written bytes */
  readonly sha256: string
}

/** The bytes read back do not hash to the sha256 recorded at upload. */
export class DocumentIntegrityError extends Error {
  constructor(
    readonly documentId: string,
    readonly version: number,
  ) {
    super(`version ${version} of document ${documentId} failed its sha256 integrity check`)
    this.name = 'DocumentIntegrityError'
  }
}

/** A version row exists but its file is absent (disk loss / crash window). */
export class DocumentFileMissingError extends Error {
  constructor(
    readonly documentId: string,
    readonly version: number,
  ) {
    super(`file for version ${version} of document ${documentId} is missing`)
    this.name = 'DocumentFileMissingError'
  }
}

/** Best-effort removal: an already-gone file is success, anything else throws. */
async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Byte store rooted at `dataDir` (GENOFFICE_BACKEND_DATA_DIR). `maxBytes`
 * defaults to the documented 200 MiB cap; the app factory exposes it purely
 * so unit tests can exercise the 413 path without allocating 200 MiB.
 */
export class DocumentFileStore {
  readonly maxBytes: number
  readonly #rootDir: string

  constructor(rootDir: string, maxBytes: number = MAX_DOCUMENT_BYTES) {
    this.#rootDir = rootDir
    this.maxBytes = maxBytes
  }

  /** `<dataDir>/<urlencoded sub>/<documentId>` */
  #documentDir(sub: string, documentId: string): string {
    return join(this.#rootDir, encodeURIComponent(sub), documentId)
  }

  #versionPath(sub: string, documentId: string, version: number): string {
    return join(this.#documentDir(sub, documentId), String(version))
  }

  async #assertPresent(sub: string, documentId: string, version: number): Promise<string> {
    const path = this.#versionPath(sub, documentId, version)
    try {
      await stat(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DocumentFileMissingError(documentId, version)
      }
      throw err
    }
    return path
  }

  /**
   * Streams `source` into the document directory as the given version,
   * counting bytes and hashing as they pass. Throws 413 `payload_too_large`
   * the moment the cap is exceeded (the staged file is removed again; nothing
   * oversized ever lands). The staging rename happens here, before the
   * caller commits rows — see the module docblock.
   *
   * The copy is a hand-rolled `pipe`, not `stream.pipeline`, on purpose:
   * pipeline destroys its source on failure, and for raw uploads the source
   * IS the HTTP request stream — destroying it resets the connection before
   * the 413 can be delivered. On failure the source is unpiped and drained
   * instead, so the caller's error response still reaches the client.
   */
  async writeVersion(
    sub: string,
    documentId: string,
    version: number,
    source: Readable,
  ): Promise<StoredBlob> {
    const dir = this.#documentDir(sub, documentId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const stagingPath = join(dir, `.staging-${randomUUID()}`)
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length
        if (size > this.maxBytes) {
          callback(payloadTooLarge())
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    const target = createWriteStream(stagingPath, { mode: 0o600 })
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (err: unknown): void => {
          source.unpipe(meter)
          // Drain the remainder to /dev/null: the request must still be
          // consumable for the error response to be sent and the socket
          // kept usable.
          source.resume()
          meter.destroy()
          target.destroy()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        source.once('error', fail)
        meter.once('error', fail)
        target.once('error', fail)
        target.once('finish', () => resolve())
        source.pipe(meter).pipe(target)
      })
      const blob: StoredBlob = { size, sha256: hash.digest('hex') }
      await rename(stagingPath, this.#versionPath(sub, documentId, version))
      return blob
    } catch (err) {
      // The staging file (or, if the rename itself failed, nothing) is the
      // only leftover. Cleaning it up is best-effort and must never mask the
      // original error — e.g. a cleanup EACCES turning the 413 into a 500.
      await removeFile(stagingPath).catch(() => {})
      throw err
    }
  }

  /**
   * Re-hashes the stored bytes and compares with the sha256 recorded at
   * upload. Two passes per download (hash, then send) is the price of
   * answering a corrupt file with a clean 500 instead of corrupt bytes.
   */
  async verifyVersion(
    sub: string,
    documentId: string,
    version: number,
    expectedSha256: string,
  ): Promise<void> {
    const path = await this.#assertPresent(sub, documentId, version)
    const hash = createHash('sha256')
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        hash.update(chunk)
        callback()
      },
    })
    await pipeline(createReadStream(path), sink)
    if (hash.digest('hex') !== expectedSha256) {
      throw new DocumentIntegrityError(documentId, version)
    }
  }

  /**
   * Read stream over a version's bytes. Call {@link verifyVersion} first —
   * this only checks presence so a vanished file still surfaces as a typed
   * error instead of an erroring response stream.
   */
  async openVersion(sub: string, documentId: string, version: number): Promise<Readable> {
    const path = await this.#assertPresent(sub, documentId, version)
    return createReadStream(path)
  }

  /** Removes the files of pruned versions (ENOENT-tolerant, throws otherwise). */
  async removeVersions(sub: string, documentId: string, versions: number[]): Promise<void> {
    for (const version of versions) {
      await removeFile(this.#versionPath(sub, documentId, version))
    }
  }

  /** Removes the whole document directory (rows are already gone). */
  async removeDocument(sub: string, documentId: string): Promise<void> {
    await rm(this.#documentDir(sub, documentId), { recursive: true, force: true })
  }
}
