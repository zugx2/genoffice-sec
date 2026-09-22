import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDocumentStore, isExternallyModified } from '../src/index'
import type { DiskFileState } from '../src/index'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

/** scratch document folder */
let dir: string
/** scratch store root (userData stand-in: originals/ + docs-autosave/ live here) */
let root: string
let store: LocalDocumentStore

const doc = (name = 'a.docx') => ({ path: join(dir, name) })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-docs-'))
  root = mkdtempSync(join(tmpdir(), 'ds-root-'))
  store = new LocalDocumentStore(root)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  vi.mocked(rename).mockClear()
})

const epermError = () =>
  Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

describe('stored bytes', () => {
  it('round-trips write → read with the same bytes and reports size/mtime', async () => {
    const bytes = Buffer.from('PK\x03\x04 document bytes')
    await store.write(doc(), bytes)
    await expect(store.read(doc())).resolves.toEqual(bytes)
    const st = await store.stat(doc())
    expect(st.size).toBe(bytes.byteLength)
    expect(st.mtimeMs).toBeGreaterThan(0)
    await expect(store.exists(doc())).resolves.toBe(true)
  })

  it('replaces the target on write and leaves no temp file behind', async () => {
    await store.write(doc(), Buffer.from('old'))
    await store.write(doc(), Buffer.from('new'))
    expect(readFileSync(doc().path, 'utf-8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['a.docx'])
  })

  it('maps missing targets to the raw fs errors (read/stat reject, exists/remove do not)', async () => {
    const missing = doc('missing.docx')
    await expect(store.exists(missing)).resolves.toBe(false)
    await expect(store.read(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    // rollback helper: an already-gone file is not an error
    await expect(store.remove(missing)).resolves.toBeUndefined()
  })

  it('keeps the original intact and cleans the temp file when the write fails', async () => {
    await store.write(doc(), Buffer.from('old'))
    const bad = { byteLength: -1 } as unknown as Buffer
    await expect(store.write(doc(), bad)).rejects.toThrow()
    expect(readFileSync(doc().path, 'utf-8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['a.docx'])
  })

  // Windows: Defender/indexer briefly locks the target and rename throws EPERM
  it('retries a transiently locked rename and still lands atomically', async () => {
    await store.write(doc(), Buffer.from('old'))
    vi.mocked(rename).mockRejectedValueOnce(epermError()).mockRejectedValueOnce(epermError())
    await store.write(doc(), Buffer.from('new'))
    expect(readFileSync(doc().path, 'utf-8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['a.docx'])
  })

  it('falls back to an in-place write when the rename stays locked', async () => {
    await store.write(doc(), Buffer.from('old'))
    for (let i = 0; i < 5; i++) vi.mocked(rename).mockRejectedValueOnce(epermError())
    await store.write(doc(), Buffer.from('new'))
    expect(readFileSync(doc().path, 'utf-8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['a.docx'])
  })

  it('ensureFolder creates the document folder (save-to target)', async () => {
    const ref = { path: join(dir, 'nested', 'deeper', 'b.docx') }
    await store.ensureFolder(ref)
    await store.write(ref, Buffer.from('x'))
    expect(existsSync(ref.path)).toBe(true)
  })

  it('hashBytes is the sha256 of the bytes', () => {
    const bytes = Buffer.from('document')
    expect(store.hashBytes(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('uniquePathIn takes name.ext then name-2.ext, name-3.ext…', async () => {
    expect(store.uniquePathIn(dir, 'report.docx')).toBe(join(dir, 'report.docx'))
    await store.write({ path: join(dir, 'report.docx') }, Buffer.from('a'))
    expect(store.uniquePathIn(dir, 'report.docx')).toBe(join(dir, 'report-2.docx'))
    await store.write({ path: join(dir, 'report-2.docx') }, Buffer.from('a'))
    expect(store.uniquePathIn(dir, 'report.docx')).toBe(join(dir, 'report-3.docx'))
    expect(store.uniquePathIn(dir, 'noext')).toBe(join(dir, 'noext'))
  })
})

describe('write grants', () => {
  it('only authorized owners may write, and forgetOwner revokes', async () => {
    await expect(store.canWrite(7, doc())).resolves.toBe(false)
    store.authorizeWrite(7, doc())
    await expect(store.canWrite(7, doc())).resolves.toBe(true)
    // grants are per-owner: another tab's id has none
    await expect(store.canWrite(8, doc())).resolves.toBe(false)
    store.forgetOwner(7)
    await expect(store.canWrite(7, doc())).resolves.toBe(false)
  })

  it('renameOwnerPath moves the grant and the recorded disk state', async () => {
    const ref = doc()
    await store.write(ref, Buffer.from('v1'))
    store.authorizeWrite(7, ref)
    await store.recordDiskState(7, ref, store.hashBytes(Buffer.from('v1')))
    const moved = doc('renamed.docx')
    store.renameOwnerPath(7, ref.path, moved.path)
    await expect(store.canWrite(7, ref)).resolves.toBe(false)
    await expect(store.canWrite(7, moved)).resolves.toBe(true)
    // the moved baseline still detects a change written through the new path
    await store.write(moved, Buffer.from('v2'))
    utimesSync(moved.path, new Date(), new Date(Date.now() + 5000))
    await expect(store.changedExternally(7, moved)).resolves.toBe(true)
  })
})

describe('external-change detection', () => {
  it('is false right after the save that recorded the state', async () => {
    const bytes = Buffer.from('v1')
    await store.write(doc(), bytes)
    await store.recordDiskState(7, doc(), store.hashBytes(bytes))
    await expect(store.changedExternally(7, doc())).resolves.toBe(false)
  })

  // the regression the docs editor carries this for: another program's write
  // must be detected before a save overwrites it
  it('is true when another program rewrote the file', async () => {
    await store.write(doc(), Buffer.from('v1'))
    await store.recordDiskState(7, doc(), store.hashBytes(Buffer.from('v1')))
    await store.write(doc(), Buffer.from('someone else'))
    // mtime granularity: force the stamp to move so the hash comparison runs
    utimesSync(doc().path, new Date(), new Date(Date.now() + 5000))
    await expect(store.changedExternally(7, doc())).resolves.toBe(true)
  })

  it('is false when the stamp moved but the content is unchanged (touch)', async () => {
    await store.write(doc(), Buffer.from('v1'))
    await store.recordDiskState(7, doc(), store.hashBytes(Buffer.from('v1')))
    utimesSync(doc().path, new Date(), new Date(Date.now() + 5000))
    await expect(store.changedExternally(7, doc())).resolves.toBe(false)
  })

  it('is false without a recorded state and after external deletion', async () => {
    await store.write(doc(), Buffer.from('v1'))
    // never recorded → no conflict
    await expect(store.changedExternally(7, doc())).resolves.toBe(false)
    await store.recordDiskState(7, doc(), store.hashBytes(Buffer.from('v1')))
    await store.remove(doc())
    // deleted externally → the save proceeds and recreates the file
    await expect(store.changedExternally(7, doc())).resolves.toBe(false)
  })
})

describe('originals archive', () => {
  it('archives the on-disk original under its content hash, first copy wins', async () => {
    const v1 = Buffer.from('original bytes')
    await store.write(doc(), v1)
    const hash = store.hashBytes(v1)
    await store.archiveOriginal(doc(), hash, v1.byteLength)
    const archived = join(root, 'originals', `${hash}.docx`)
    expect(readFileSync(archived)).toEqual(v1)
    // a later archive under the same hash never overwrites the first copy
    const v2 = Buffer.from('rewritten bytes')
    await store.write(doc(), v2)
    await store.archiveOriginal(doc(), hash, v2.byteLength)
    expect(readFileSync(archived)).toEqual(v1)
  })

  it('skips documents larger than the archive cap', async () => {
    await store.write(doc(), Buffer.from('huge in spirit only'))
    await store.archiveOriginal(doc(), store.hashBytes(Buffer.from('x')), 500 * 1024 * 1024 + 1)
    expect(readdirSync(root)).toEqual([])
  })
})

describe('recovery copies', () => {
  it('writes into the recovery dir and reads back the bytes', async () => {
    await store.write(doc(), Buffer.from('doc'))
    const bytes = Buffer.from('unsaved edits')
    await store.writeRecovery(doc(), bytes)
    expect(readdirSync(join(root, 'docs-autosave'))).toHaveLength(1)
    await expect(store.readRecovery(doc())).resolves.toEqual(bytes)
    await expect(store.readRecovery(doc('other.docx'))).resolves.toBeNull()
  })

  it('recoveryStamp compares copy vs document mtimes and is null without a copy', async () => {
    await store.write(doc(), Buffer.from('doc'))
    expect(store.recoveryStamp(doc())).toBeNull()
    await store.writeRecovery(doc(), Buffer.from('newer'))
    utimesSync(doc().path, new Date(), new Date(Date.now() - 10_000))
    const stamp = store.recoveryStamp(doc())
    expect(stamp).not.toBeNull()
    expect(stamp!.recoveryMtimeMs).toBeGreaterThan(stamp!.documentMtimeMs)
  })

  it('clearRecovery removes the copy and bumps the epoch (stale-write race guard)', async () => {
    await store.write(doc(), Buffer.from('doc'))
    expect(store.recoveryEpoch(doc())).toBe(0)
    await store.writeRecovery(doc(), Buffer.from('unsaved'))
    store.clearRecovery(doc())
    expect(existsSync(join(root, 'docs-autosave'))).toBe(true) // dir stays, copy is gone
    expect(readdirSync(join(root, 'docs-autosave'))).toHaveLength(0)
    expect(store.recoveryEpoch(doc())).toBe(1)
    expect(store.recoveryStamp(doc())).toBeNull()
    store.clearRecovery(doc())
    expect(store.recoveryEpoch(doc())).toBe(2)
  })

  it('sweepRecoveryCopies clears every copy of an owner-writable document', async () => {
    const a = doc('a.docx')
    const b = doc('b.docx')
    await store.write(a, Buffer.from('a'))
    await store.write(b, Buffer.from('b'))
    store.authorizeWrite(7, a)
    store.authorizeWrite(7, b)
    await store.writeRecovery(a, Buffer.from('a-unsaved'))
    await store.writeRecovery(b, Buffer.from('b-unsaved'))
    store.sweepRecoveryCopies(7)
    expect(store.recoveryStamp(a)).toBeNull()
    expect(store.recoveryStamp(b)).toBeNull()
  })
})

describe('isExternallyModified (extracted pure rule)', () => {
  const recorded: DiskFileState = { mtimeMs: 1000, size: 42, hash: 'aaa' }

  it('is false when mtime and size still match (no hash read)', async () => {
    const readHash = vi.fn(() => 'zzz')
    await expect(
      isExternallyModified(recorded, { mtimeMs: 1000, size: 42 }, readHash),
    ).resolves.toBe(false)
    expect(readHash).not.toHaveBeenCalled()
  })

  it('is true when the content on disk changed, with sync or async hash readers', async () => {
    await expect(
      isExternallyModified(recorded, { mtimeMs: 2000, size: 43 }, () => 'bbb'),
    ).resolves.toBe(true)
    await expect(
      isExternallyModified(recorded, { mtimeMs: 2000, size: 43 }, async () => 'bbb'),
    ).resolves.toBe(true)
  })

  it('is false when the hash reader fails (unreadable change)', async () => {
    await expect(
      isExternallyModified(recorded, { mtimeMs: 2000, size: 43 }, () => null),
    ).resolves.toBe(false)
  })
})
