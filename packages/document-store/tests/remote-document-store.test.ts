import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  baseUrlTransport,
  RemoteDocumentApiError,
  RemoteDocumentNotFoundError,
  RemoteDocumentStore,
  RemoteDocumentUnavailableError,
  type DocumentConflictEvent,
  type DocumentRef,
} from '../src/index'
import { MockDocumentBackend, type RecordedRequest } from './mock-backend'

/** scratch temp dir (the injected ephemeral scratch root) */
let tempDir: string
let backend: MockDocumentBackend
let store: RemoteDocumentStore

const ref = (path = '/user/docs/report.docx'): DocumentRef => ({ path })

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ds-remote-'))
  backend = new MockDocumentBackend()
  store = new RemoteDocumentStore({ transport: backend.transport, tempDir })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

const puts = (): RecordedRequest[] => backend.requests.filter((r) => r.method === 'PUT')

describe('open: download into memory', () => {
  it('rejects with the typed not-found error when no cloud document is bound', async () => {
    await expect(store.read(ref())).rejects.toBeInstanceOf(RemoteDocumentNotFoundError)
    await expect(store.exists(ref())).resolves.toBe(false)
    await expect(store.stat(ref())).rejects.toMatchObject({ code: 'not_found' })
    // nothing was asked of the server
    expect(backend.requests).toEqual([])
  })

  it('downloads the bytes and parses the ETag into the ref version', async () => {
    const id = backend.seedDocument('cloud.docx', Buffer.from('server bytes'))
    const doc: DocumentRef = { path: '/user/docs/cloud.docx', cloudId: id }
    await expect(store.read(doc)).resolves.toEqual(Buffer.from('server bytes'))
    expect(doc.version).toBe(1)
    expect(backend.requests).toEqual([
      {
        method: 'GET',
        path: `/documents/${id}`,
        headers: {},
        rawBody: null,
        fields: null,
        file: null,
      },
    ])
  })

  it('ignores a non-integer ETag (the ref keeps no version, the next save is unguarded)', async () => {
    const quoted = new RemoteDocumentStore({
      transport: async () =>
        new Response(new Uint8Array([65]), { status: 200, headers: { etag: '"1"' } }),
      tempDir,
    })
    const doc: DocumentRef = { path: '/x/a.docx', cloudId: 'some-id' }
    await expect(quoted.read(doc)).resolves.toEqual(Buffer.from('A'))
    expect(doc.version).toBeUndefined()
  })

  it('reports existence and metadata from the document list', async () => {
    const id = backend.seedDocument('cloud.docx', Buffer.alloc(1024, 7))
    const doc: DocumentRef = { path: '/x/a.docx', cloudId: id }
    await expect(store.exists(doc)).resolves.toBe(true)
    const st = await store.stat(doc)
    expect(st.size).toBe(1024)
    expect(st.mtimeMs).toBeGreaterThan(0)
    backend.hardDelete(id)
    await expect(store.exists(doc)).resolves.toBe(false)
    await expect(store.stat(doc)).rejects.toBeInstanceOf(RemoteDocumentNotFoundError)
  })
})

describe('save: create, then version-guarded updates', () => {
  it('POSTs multipart (name, kind, file) on the first save and records the new identity', async () => {
    const bytes = Buffer.from('PK\x03\x04 first save')
    const doc = ref()
    await store.write(doc, bytes)
    expect(backend.requests).toHaveLength(1)
    const [post] = backend.requests
    expect(post!.method).toBe('POST')
    expect(post!.path).toBe('/documents')
    expect(post!.fields).toMatchObject({ name: 'report.docx', kind: 'docx' })
    expect(post!.file).toMatchObject({ field: 'file', filename: 'report.docx' })
    expect(post!.file!.bytes).toEqual(bytes)
    expect(doc.cloudId).toMatch(/./)
    expect(doc.version).toBe(1)
    expect(backend.bytesOf(doc.cloudId!)).toEqual(bytes)
  })

  it('sends exactly one well-formed multipart body (independently parsed structure)', async () => {
    const bytes = Buffer.from('body with unicode ✓ and CRLF\r\ninside')
    await store.write(ref('/user/docs/notes.md'), bytes)
    const [post] = backend.requests
    const contentType = post!.headers['content-type']!
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    const boundary = contentType.replace(/^multipart\/form-data; boundary=/, '')
    // the boundary delimits: opener, one per part, closer
    const body = post!.rawBody!.toString('utf8')
    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true)
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true)
    // the boundary token appears exactly four times: opener, before each of
    // the two field parts and the file part, and the closer
    expect(body.split(`--${boundary}`)).toHaveLength(5)
    expect(body).toContain('content-disposition: form-data; name="name"')
    expect(body).toContain('content-disposition: form-data; name="kind"')
    expect(body).toContain('content-type: application/octet-stream')
    // the file part's disposition is present and the bytes round-tripped
    expect(post!.file!.bytes).toEqual(bytes)
  })

  it('PUTs with If-Match of the ref version and records the new version', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1'))
    await store.write(doc, Buffer.from('v2'))
    const [post, put] = backend.requests
    expect(post!.method).toBe('POST')
    expect(put!.method).toBe('PUT')
    expect(put!.path).toBe(`/documents/${doc.cloudId}`)
    expect(put!.headers['if-match']).toBe('1')
    expect(put!.fields).toEqual({}) // an update keeps the server's name/kind
    expect(put!.file!.bytes).toEqual(Buffer.from('v2'))
    expect(doc.version).toBe(2)
    expect(backend.bytesOf(doc.cloudId!)).toEqual(Buffer.from('v2'))
  })

  it('uploads unguarded when the ref carries no version (last-writer-wins)', async () => {
    const id = backend.seedDocument()
    const doc: DocumentRef = { path: '/x/a.docx', cloudId: id } // never read: no version known
    await store.write(doc, Buffer.from('blind write'))
    expect(puts()).toHaveLength(1)
    expect(puts()[0]!.headers['if-match']).toBeUndefined()
    expect(doc.version).toBe(2)
  })

  it('derives kind from the extension and caps the name to the wire limit', async () => {
    await store.write(ref('/user/docs/NOTES.MD'), Buffer.from('x'))
    expect(backend.requests[0]!.fields).toMatchObject({ name: 'NOTES.MD', kind: 'md' })
    const long = `${'n'.repeat(300)}.docx`
    await store.write(ref(join('/user/docs', long)), Buffer.from('x'))
    expect(backend.requests[1]!.fields!.name.length).toBeLessThanOrEqual(255)
  })

  it("serializes one document's saves: back-to-back writes chain versions, never 409", async () => {
    backend.delayMs = 20
    const doc = ref()
    await Promise.all([store.write(doc, Buffer.from('a')), store.write(doc, Buffer.from('b'))])
    const [post, put] = backend.requests
    expect(post!.method).toBe('POST')
    expect(put!.method).toBe('PUT')
    expect(put!.headers['if-match']).toBe('1')
    expect(doc.version).toBe(2)
    expect(backend.bytesOf(doc.cloudId!)).toEqual(Buffer.from('b'))
  })
})

describe('conflict policy: 409 → conflict copy', () => {
  it('re-PUTs with ?conflict=copy, re-points the ref, flags it, leaves the original intact', async () => {
    const conflicts: DocumentConflictEvent[] = []
    const wired = new RemoteDocumentStore({
      transport: backend.transport,
      tempDir,
      onConflict: (event) => conflicts.push(event),
    })
    const doc = ref()
    await wired.write(doc, Buffer.from('mine v1'))
    const originalId = doc.cloudId!
    // another device wins the race
    backend.bumpVersion(originalId)
    const theirs = backend.bytesOf(originalId)

    await wired.write(doc, Buffer.from('mine v2'))

    const [post, guarded, copy] = backend.requests
    expect(post!.method).toBe('POST')
    expect(guarded!.method).toBe('PUT')
    expect(guarded!.path).toBe(`/documents/${originalId}`)
    expect(guarded!.headers['if-match']).toBe('1')
    expect(copy!.method).toBe('PUT')
    expect(copy!.path).toBe(`/documents/${originalId}?conflict=copy`)
    expect(copy!.headers['if-match']).toBeUndefined()
    expect(copy!.file!.bytes).toEqual(Buffer.from('mine v2'))

    // the ref now follows the copy; the original keeps the other device's bytes
    expect(doc.cloudId).toMatch(/./)
    expect(doc.cloudId).not.toBe(originalId)
    expect(doc.version).toBe(1)
    expect(doc.conflicted).toBe(true)
    expect(backend.bytesOf(originalId)).toEqual(theirs)
    expect(backend.bytesOf(doc.cloudId!)).toEqual(Buffer.from('mine v2'))
    expect(conflicts).toEqual([
      {
        path: doc.path,
        previousCloudId: originalId,
        cloudId: doc.cloudId,
        version: 1,
      },
    ])
  })

  it('clears the flag on the next clean save of the copy', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1'))
    backend.bumpVersion(doc.cloudId!)
    await store.write(doc, Buffer.from('v2'))
    expect(doc.conflicted).toBe(true)
    const copyId = doc.cloudId!
    await store.write(doc, Buffer.from('v3'))
    expect(doc.conflicted).toBe(false)
    expect(doc.cloudId).toBe(copyId)
    expect(doc.version).toBe(2)
    expect(backend.bytesOf(copyId)).toEqual(Buffer.from('v3'))
  })

  it('keeps the flag when the save fails (only a clean upload clears it)', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1'))
    backend.bumpVersion(doc.cloudId!)
    await store.write(doc, Buffer.from('v2'))
    expect(doc.conflicted).toBe(true)
    backend.failNext = 1
    await expect(store.write(doc, Buffer.from('v3'))).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(doc.conflicted).toBe(true)
  })

  it('recreates the mirror when the server copy vanished (404 self-heal)', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1'))
    const vanished = doc.cloudId!
    backend.hardDelete(vanished)
    await store.write(doc, Buffer.from('v2'))
    const [_post, put, recreate] = backend.requests
    expect(put!.path).toBe(`/documents/${vanished}`)
    expect(recreate!.method).toBe('POST')
    expect(doc.cloudId).toMatch(/./)
    expect(doc.cloudId).not.toBe(vanished)
    expect(doc.version).toBe(1)
    expect(backend.bytesOf(doc.cloudId!)).toEqual(Buffer.from('v2'))
  })
})

describe('delete', () => {
  it('sends DELETE with the ref version and removes the document', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('x'))
    await store.remove(doc)
    const [del] = backend.requests.filter((r) => r.method === 'DELETE')
    expect(del!.path).toBe(`/documents/${doc.cloudId}`)
    expect(del!.headers['if-match']).toBe('1')
    await expect(store.exists(doc)).resolves.toBe(false)
  })

  it('is best-effort: an already-deleted document resolves, a stale guard finishes unguarded', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('x'))
    backend.hardDelete(doc.cloudId!)
    await expect(store.remove(doc)).resolves.toBeUndefined()

    const second = ref('/user/docs/second.docx')
    await store.write(second, Buffer.from('x'))
    backend.bumpVersion(second.cloudId!) // the guard is now stale
    await expect(store.remove(second)).resolves.toBeUndefined()
    const deletes = backend.requests.filter((r) => r.method === 'DELETE')
    expect(deletes).toHaveLength(3) // the 404 tolerance, then guard + retry
    expect(deletes[1]!.headers['if-match']).toBe('1')
    expect(deletes[2]!.headers['if-match']).toBeUndefined()
    await expect(store.exists(second)).resolves.toBe(false)
  })
})

describe('external-change detection (server version checks)', () => {
  it('is false while the recorded version matches, true after another device uploads', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1'))
    store.authorizeWrite(7, doc)
    await store.recordDiskState(7, doc, store.hashBytes(Buffer.from('v1')))
    await expect(store.changedExternally(7, doc)).resolves.toBe(false)
    backend.bumpVersion(doc.cloudId!)
    await expect(store.changedExternally(7, doc)).resolves.toBe(true)
    // a vanished document is not a conflict (the save recreates the mirror)
    backend.hardDelete(doc.cloudId!)
    await expect(store.changedExternally(7, doc)).resolves.toBe(false)
  })

  it('is false without a recorded version (never read/tracked)', async () => {
    const id = backend.seedDocument()
    const doc: DocumentRef = { path: '/x/a.docx', cloudId: id }
    await expect(store.changedExternally(7, doc)).resolves.toBe(false)
  })
})

describe('write grants (id-keyed)', () => {
  it('authorizes by cloud id, per owner, and forgets with the owner', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('x'))
    await expect(store.canWrite(7, doc)).resolves.toBe(false)
    store.authorizeWrite(7, doc)
    await expect(store.canWrite(7, doc)).resolves.toBe(true)
    // the same document under a different owner is not writable
    await expect(store.canWrite(8, doc)).resolves.toBe(false)
    store.forgetOwner(7)
    await expect(store.canWrite(7, doc)).resolves.toBe(false)
  })

  it('renames only path-keyed grants (the op is local-only)', async () => {
    // before creation the grant is keyed by the path stand-in, which moves
    const unsaved = ref('/user/docs/old.docx')
    store.authorizeWrite(7, unsaved)
    store.renameOwnerPath(7, '/user/docs/old.docx', '/user/docs/new.docx')
    await expect(store.canWrite(7, ref('/user/docs/old.docx'))).resolves.toBe(false)
    await expect(store.canWrite(7, ref('/user/docs/new.docx'))).resolves.toBe(true)

    // once a cloud id exists it is the key, so a rename changes nothing
    const doc = ref('/user/docs/cloud.docx')
    await store.write(doc, Buffer.from('x'))
    store.authorizeWrite(7, doc)
    store.renameOwnerPath(7, doc.path, '/user/docs/renamed.docx')
    await expect(store.canWrite(7, doc)).resolves.toBe(true)
  })
})

describe('local-parity pass-throughs', () => {
  it('hashBytes is sha256, ensureFolder is a no-op, uniquePathIn joins without a registry', async () => {
    expect(store.hashBytes(Buffer.from('x'))).toHaveLength(64)
    await expect(store.ensureFolder(ref())).resolves.toBeUndefined()
    expect(store.uniquePathIn('/a/b', 'c.docx')).toBe(join('/a/b', 'c.docx'))
    expect(backend.requests).toEqual([])
  })

  it('archiveOriginal keeps no local copy (the server history is the safety net)', async () => {
    await expect(store.archiveOriginal(ref(), 'deadbeef', 10)).resolves.toBeUndefined()
    expect(readdirSync(tempDir)).toEqual([])
    expect(backend.requests).toEqual([])
  })
})

describe('error surface', () => {
  it('classifies transport failures as unavailable', async () => {
    backend.failNext = 1
    await expect(store.write(ref(), Buffer.from('x'))).rejects.toMatchObject({
      code: 'unavailable',
    })
  })

  it('classifies a dead session (401 after the transport refresh) as unavailable', async () => {
    const dead = new RemoteDocumentStore({
      transport: async () =>
        new Response('{"error":{"code":"unauthorized"}}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      tempDir,
    })
    await expect(dead.exists({ path: '/x/a.docx', cloudId: 'id' })).rejects.toBeInstanceOf(
      RemoteDocumentUnavailableError,
    )
  })

  it("keeps the server's stable error code for other rejections", async () => {
    backend.rejectNextUpload = { status: 413, code: 'payload_too_large' }
    await expect(store.write(ref(), Buffer.from('x'))).rejects.toBeInstanceOf(
      RemoteDocumentApiError,
    )
    backend.rejectNextUpload = { status: 413, code: 'payload_too_large' }
    await expect(store.write(ref(), Buffer.from('x'))).rejects.toMatchObject({
      code: 'http_error',
      status: 413,
      message: expect.stringContaining('payload_too_large'),
    })
  })
})

describe('ephemeral scratch (engines that need a real file)', () => {
  it('writes tracked unique files and cleanupAll wipes the set', async () => {
    const a = await store.scratch.write('engine.docx', Buffer.from('a'))
    const b = await store.scratch.write('engine.docx', Buffer.from('b'))
    expect(a).not.toBe(b)
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(true)
    expect(store.scratch.tracked()).toEqual([a, b])
    await store.scratch.cleanupAll()
    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(false)
    expect(store.scratch.tracked()).toEqual([])
  })

  it('registerExitWipe wires a synchronous wipe the host owns', async () => {
    const hooks: Array<() => void> = []
    store.scratch.registerExitWipe((wipe) => hooks.push(wipe))
    const path = await store.scratch.write('engine.docx', Buffer.from('a'))
    expect(hooks).toHaveLength(1)
    hooks[0]!()
    expect(existsSync(path)).toBe(false)
  })

  it('stablePathFor maps the same label to the same file', () => {
    expect(store.scratch.stablePathFor('recovery-abc')).toBe(
      store.scratch.stablePathFor('recovery-abc'),
    )
    expect(store.scratch.stablePathFor('recovery-abc')).not.toBe(
      store.scratch.stablePathFor('recovery-def'),
    )
  })
})

describe('crash-recovery buffer (ephemeral, server autosave comes later)', () => {
  it('writes, reads, stamps against the last sync, and clears with an epoch bump', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1')) // sets the sync clock
    expect(store.recoveryStamp(doc)).toBeNull()
    await store.writeRecovery(doc, Buffer.from('unsaved edits'))
    await expect(store.readRecovery(doc)).resolves.toEqual(Buffer.from('unsaved edits'))
    const stamp = store.recoveryStamp(doc)
    expect(stamp).not.toBeNull()
    expect(stamp!.recoveryMtimeMs).toBeGreaterThanOrEqual(stamp!.documentMtimeMs)
    expect(store.recoveryEpoch(doc)).toBe(0)
    store.clearRecovery(doc)
    expect(store.recoveryEpoch(doc)).toBe(1)
    expect(store.recoveryStamp(doc)).toBeNull()
    await expect(store.readRecovery(doc)).resolves.toBeNull()
  })

  it('sweeps every buffer of an owner-writable document', async () => {
    const doc = ref()
    await store.write(doc, Buffer.from('v1'))
    store.authorizeWrite(7, doc)
    await store.writeRecovery(doc, Buffer.from('unsaved'))
    expect(store.recoveryStamp(doc)).not.toBeNull()
    store.sweepRecoveryCopies(7)
    expect(store.recoveryStamp(doc)).toBeNull()
    expect(store.scratch.tracked()).toEqual([])
  })
})

describe('baseUrlTransport (base URL as the input when no client carries it)', () => {
  it('joins the path onto the base, keeping its prefix and collapsing slashes', async () => {
    const seen: string[] = []
    const transport = baseUrlTransport('https://api.example.com/v1/', async (url) => {
      seen.push(url)
      return new Response('{"documents":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = new RemoteDocumentStore({ transport, tempDir })
    await expect(client.exists({ path: '/x/a.docx', cloudId: 'id' })).resolves.toBe(false)
    expect(seen).toEqual(['https://api.example.com/v1/documents'])
  })
})
