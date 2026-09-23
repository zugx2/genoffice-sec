import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HybridDocumentStore,
  LocalDocumentStore,
  RemoteDocumentStore,
  type DocumentRef,
  type PendingDocumentUpload,
} from '../src/index'
import { MockDocumentBackend, type RecordedRequest } from './mock-backend'

/** the working copy's folder */
let dir: string
/** the local store's root (originals/ + docs-autosave/) */
let root: string
/** the remote half's ephemeral scratch root */
let tempDir: string
let backend: MockDocumentBackend
let store: HybridDocumentStore

const ref = (name = 'report.docx'): DocumentRef => ({ path: join(dir, name) })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hybrid-docs-'))
  root = mkdtempSync(join(tmpdir(), 'hybrid-root-'))
  tempDir = mkdtempSync(join(tmpdir(), 'hybrid-temp-'))
  backend = new MockDocumentBackend()
  store = new HybridDocumentStore(
    new LocalDocumentStore(root),
    new RemoteDocumentStore({ transport: backend.transport, tempDir }),
  )
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  rmSync(tempDir, { recursive: true, force: true })
})

const puts = (): RecordedRequest[] => backend.requests.filter((r) => r.method === 'PUT')

describe('upload-on-save mirror', () => {
  it('creates the cloud document on the first save, then appends versions', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1'))
    // the working copy landed locally with the exact bytes
    expect(readFileSync(doc.path)).toEqual(Buffer.from('v1'))
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0]!.method).toBe('POST')
    expect(doc.cloudId).toBeTruthy()
    expect(doc.version).toBe(1)

    await store.write(doc, Buffer.from('v2'))
    expect(readFileSync(doc.path)).toEqual(Buffer.from('v2'))
    const put = puts()[0]!
    expect(put.path).toBe(`/documents/${doc.cloudId}`)
    expect(put.headers['if-match']).toBe('1')
    expect(put.file!.bytes).toEqual(Buffer.from('v2'))
    expect(doc.version).toBe(2)
    // the server keeps the version history the mode exists for
    expect(backend.bytesOf(doc.cloudId!)).toEqual(Buffer.from('v2'))
  })

  it('records no pending upload while the mirror lands', async () => {
    await store.write(ref(), Buffer.from('x'))
    expect(store.pendingUploads).toEqual([])
  })
})

describe('mirror isolation (a failed upload never fails the local save)', () => {
  it('resolves the save, keeps the local bytes, records + pushes the failure', async () => {
    const pending: PendingDocumentUpload[] = []
    const wired = new HybridDocumentStore(
      new LocalDocumentStore(root),
      new RemoteDocumentStore({ transport: backend.transport, tempDir }),
      { onPendingUpload: (entry) => pending.push(entry) },
    )
    const doc = ref()
    await wired.write(doc, Buffer.from('v1')) // creates the mirror
    backend.failNext = 1 // the next transport call dies

    await expect(wired.write(doc, Buffer.from('v2'))).resolves.toBeUndefined()
    expect(readFileSync(doc.path)).toEqual(Buffer.from('v2')) // the local save landed
    expect(store).toBeDefined()
    expect(wired.pendingUploads).toHaveLength(1)
    const [entry] = wired.pendingUploads
    expect(entry!.path).toBe(doc.path)
    expect(entry!.cloudId).toBe(doc.cloudId)
    expect(entry!.error).toMatchObject({ code: 'unavailable' })
    expect(pending).toHaveLength(1)
    // the server still holds the last mirrored version, not the failed one
    expect(backend.bytesOf(doc.cloudId!)).toEqual(Buffer.from('v1'))
  })

  it('drops the entry when a later save of the same document mirrors cleanly', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1'))
    backend.failNext = 1
    await store.write(doc, Buffer.from('v2'))
    expect(store.pendingUploads).toHaveLength(1)
    await store.write(doc, Buffer.from('v3'))
    expect(store.pendingUploads).toEqual([])
    expect(backend.bytesOf(doc.cloudId!)).toEqual(Buffer.from('v3'))
    // clearPendingUploads lets a caller ack what it has surfaced
    backend.failNext = 1
    await store.write(doc, Buffer.from('v4'))
    expect(store.pendingUploads).toHaveLength(1)
    store.clearPendingUploads()
    expect(store.pendingUploads).toEqual([])
  })

  it('keeps a pending entry for another document until that one mirrors', async () => {
    const a = ref('a.docx')
    const b = ref('b.docx')
    await store.write(a, Buffer.from('a'))
    backend.failNext = 1
    await store.write(b, Buffer.from('b')) // b's create fails
    expect(store.pendingUploads).toHaveLength(1)
    await store.write(a, Buffer.from('a2')) // a mirrors fine
    expect(store.pendingUploads).toHaveLength(1) // b's entry stays
    expect(store.pendingUploads[0]!.path).toBe(b.path)
  })
})

describe('conflict policy (version/ETag check → conflict copies)', () => {
  it('409 → second PUT with ?conflict=copy, new cloudId, local bytes unchanged by the policy', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('mine v1'))
    const originalId = doc.cloudId!
    backend.bumpVersion(originalId) // another device saved first
    const theirs = backend.bytesOf(originalId)

    await store.write(doc, Buffer.from('mine v2'))

    const [guarded, copy] = puts()
    expect(guarded!.path).toBe(`/documents/${originalId}`)
    expect(guarded!.headers['if-match']).toBe('1')
    expect(copy!.path).toBe(`/documents/${originalId}?conflict=copy`)
    expect(copy!.file!.bytes).toEqual(Buffer.from('mine v2'))

    // the working copy keeps exactly what was saved (no rollback, no merge)
    expect(readFileSync(doc.path)).toEqual(Buffer.from('mine v2'))
    // the diverging original is intact server-side
    expect(backend.bytesOf(originalId)).toEqual(theirs)
    // the ref follows the copy, flagged for the caller to surface
    expect(doc.cloudId).not.toBe(originalId)
    expect(doc.version).toBe(1)
    expect(doc.conflicted).toBe(true)
    expect(backend.bytesOf(doc.cloudId!)).toEqual(Buffer.from('mine v2'))
    // the mirror failure bookkeeping is not involved: the save mirrored, as a copy
    expect(store.pendingUploads).toEqual([])
  })

  it('the next save updates the copy and clears the flag', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1'))
    backend.bumpVersion(doc.cloudId!)
    await store.write(doc, Buffer.from('v2'))
    expect(doc.conflicted).toBe(true)
    const copyId = doc.cloudId!
    await store.write(doc, Buffer.from('v3'))
    expect(doc.conflicted).toBe(false)
    expect(doc.cloudId).toBe(copyId)
    expect(backend.bytesOf(copyId)).toEqual(Buffer.from('v3'))
  })
})

describe('opening a cloud document downloads it to a local file', () => {
  it('reads the working copy when it exists (no download)', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('local copy'))
    const requestsBefore = backend.requests.length
    await expect(store.read(doc)).resolves.toEqual(Buffer.from('local copy'))
    expect(backend.requests).toHaveLength(requestsBefore)
  })

  it('downloads, lands the local file, and records the version', async () => {
    const id = backend.seedDocument('cloud.docx', Buffer.from('from the server'))
    const doc: DocumentRef = { path: join(dir, 'cloud.docx'), cloudId: id }
    await expect(store.read(doc)).resolves.toEqual(Buffer.from('from the server'))
    expect(existsSync(doc.path)).toBe(true)
    expect(readFileSync(doc.path)).toEqual(Buffer.from('from the server'))
    expect(doc.version).toBe(1)
    // the second read is served by the working copy
    const requestsBefore = backend.requests.length
    await expect(store.read(doc)).resolves.toEqual(Buffer.from('from the server'))
    expect(backend.requests).toHaveLength(requestsBefore)
  })

  it('exists/stat fall back to the server while the working copy is missing', async () => {
    const id = backend.seedDocument('cloud.docx', Buffer.alloc(2048, 3))
    const doc: DocumentRef = { path: join(dir, 'cloud.docx'), cloudId: id }
    await expect(store.exists(doc)).resolves.toBe(true)
    await expect(store.stat(doc)).resolves.toMatchObject({ size: 2048 })
  })

  it('a document with no working copy and no cloud id reads as missing locally', async () => {
    const doc = ref('never-created.docx')
    await expect(store.exists(doc)).resolves.toBe(false)
    await expect(store.read(doc)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(backend.requests).toEqual([])
  })
})

describe('delegation to the local half (the working copy is authoritative)', () => {
  it('remove deletes only the working copy — saves are what mirror', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('x'))
    await store.remove(doc)
    expect(existsSync(doc.path)).toBe(false)
    expect(backend.requests.filter((r) => r.method === 'DELETE')).toEqual([])
    await expect(store.exists(doc)).resolves.toBe(true) // the server copy stays
  })

  it('grants, external-change detection, archive, and recovery keep local semantics', async () => {
    const doc = ref()
    const bytes = Buffer.from('v1')
    await store.write(doc, bytes)
    store.authorizeWrite(7, doc)
    await expect(store.canWrite(7, doc)).resolves.toBe(true)
    await expect(store.canWrite(8, doc)).resolves.toBe(false)

    // external-change detection is the local mtime/size/hash rule
    await store.recordDiskState(7, doc, store.hashBytes(bytes))
    await expect(store.changedExternally(7, doc)).resolves.toBe(false)

    // the originals archive lives under the local root
    await store.archiveOriginal(doc, store.hashBytes(bytes), bytes.byteLength)
    expect(readdirSync(join(root, 'originals'))).toHaveLength(1)

    // recovery copies are the local store's, swept with the owner
    await store.writeRecovery(doc, Buffer.from('unsaved'))
    await expect(store.readRecovery(doc)).resolves.toEqual(Buffer.from('unsaved'))
    expect(store.recoveryStamp(doc)).not.toBeNull()
    store.sweepRecoveryCopies(7)
    expect(store.recoveryStamp(doc)).toBeNull()

    store.forgetOwner(7)
    await expect(store.canWrite(7, doc)).resolves.toBe(false)
  })

  it('exposes the remote half for its scratch space and conflict wiring', async () => {
    expect(store.remoteStore).toBeInstanceOf(RemoteDocumentStore)
    const path = await store.remoteStore.scratch.write('engine.docx', Buffer.from('a'))
    expect(existsSync(path)).toBe(true)
    await store.remoteStore.scratch.cleanupAll()
    expect(existsSync(path)).toBe(false)
  })

  it('ensureFolder/uniquePathIn/hashBytes are the local ops', async () => {
    const nested = { path: join(dir, 'a', 'b', 'c.docx') }
    await store.ensureFolder(nested)
    await store.write(nested, Buffer.from('x'))
    expect(existsSync(nested.path)).toBe(true)
    // name dedupe happens on disk (the working copy's folder), as locally
    expect(store.uniquePathIn(dir, 'free.docx')).toBe(join(dir, 'free.docx'))
    const taken = { path: join(dir, 'free.docx') }
    await store.write(taken, Buffer.from('x'))
    expect(store.uniquePathIn(dir, 'free.docx')).toBe(join(dir, 'free-2.docx'))
    expect(store.hashBytes(Buffer.from('x'))).toHaveLength(64)
  })
})
