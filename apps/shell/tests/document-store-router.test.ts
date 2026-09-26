/**
 * `documentStoreRouter` (src/main/auth/document-store-router.ts, Phase 7e):
 * the adapter a document's ops route through, picked from
 * `(storageMode, session state)` — against a fake backend speaking the
 * documents REST contract (the remote adapter's own test double, trimmed to
 * what routing exercises).
 *
 * Covered: the mode × session matrix (incl. the logout fallback and
 * read-only-until-signin), per-document pinning (open tabs keep their store),
 * the persistent path → cloudId association, per-mode autosave (remote
 * recovery = a server PUT), the scratch lifecycle (open/close/exit wipe),
 * open-from-cloud in both modes, download collisions, and the re-key fan-out.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudDocumentEntry } from '../src/shared/cloud-docs-api'
import type { StorageMode } from '../src/shared/storage-mode-api'
import { DocumentStoreRouter } from '../src/main/auth/document-store-router'
import type { DocumentStoreRouterDeps } from '../src/main/auth/document-store-router'

// ── fake backend (the wire subset the adapters speak) ────────────────────

interface FakeDoc {
  id: string
  name: string
  kind: string
  versions: Buffer[]
}

class FakeBackend {
  readonly requests: Array<{ method: string; path: string; ifMatch?: string }> = []
  /** transport fails outright while set (dead session / network down) */
  dead = false
  private readonly docs = new Map<string, FakeDoc>()
  private seq = 0

  /** The transport seam the router's remote adapter rides. */
  readonly transport = async (path: string, init?: RequestInit): Promise<Response> => {
    if (this.dead) throw new TypeError('fetch failed')
    const method = init?.method ?? 'GET'
    const headers = init?.headers as Record<string, string> | undefined
    this.requests.push({
      method,
      path,
      ifMatch: headers?.['if-match'],
    })
    if (method === 'GET' && path === '/documents') {
      return Response.json({
        documents: [...this.docs.values()].map((doc) => ({
          id: doc.id,
          name: doc.name,
          kind: doc.kind,
          size: doc.versions.at(-1)!.byteLength,
          currentVersion: doc.versions.length,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })),
      })
    }
    let match = /^\/documents\/([^/?]+)$/.exec(path)
    if (method === 'GET' && match !== null) {
      const doc = this.docs.get(match[1]!)
      if (doc === undefined) return Response.json({ error: { code: 'not_found' } }, { status: 404 })
      return new Response(new Uint8Array(doc.versions.at(-1)!), {
        status: 200,
        headers: { etag: String(doc.versions.length) },
      })
    }
    if (method === 'POST' && path === '/documents') {
      const { fields, file } = await parseMultipart(init)
      const id = `doc-${++this.seq}`
      this.docs.set(id, {
        id,
        name: fields.name ?? 'document',
        kind: fields.kind ?? 'docx',
        versions: [file],
      })
      return Response.json(
        { id, name: fields.name, kind: fields.kind, currentVersion: 1 },
        { status: 201 },
      )
    }
    match = /^\/documents\/([^/?]+)(\?conflict=copy)?$/.exec(path)
    if (method === 'PUT' && match !== null) {
      const { fields, file } = await parseMultipart(init)
      const doc = this.docs.get(match[1]!)
      if (doc === undefined) return Response.json({ error: { code: 'not_found' } }, { status: 404 })
      if (match[2] !== undefined) {
        const copyId = `doc-${++this.seq}`
        this.docs.set(copyId, {
          id: copyId,
          name: `${fields.name} (conflict)`,
          kind: doc.kind,
          versions: [file],
        })
        return Response.json({ id: copyId, currentVersion: 1 }, { status: 201 })
      }
      if (
        headers?.['if-match'] !== undefined &&
        Number(headers['if-match']) !== doc.versions.length
      ) {
        return Response.json({ error: { code: 'version_conflict' } }, { status: 409 })
      }
      doc.versions.push(file)
      return Response.json({ id: doc.id, currentVersion: doc.versions.length })
    }
    return Response.json({ error: { code: 'not_found' } }, { status: 404 })
  }

  /** Creates a document as another device would; returns its id. */
  seed(name: string, kind: string, bytes: Buffer): string {
    const id = `doc-${++this.seq}`
    this.docs.set(id, { id, name, kind, versions: [bytes] })
    return id
  }

  bytesOf(id: string): Buffer {
    return this.docs.get(id)!.versions.at(-1)!
  }

  /** Another device's upload (bumps the version, breaking our If-Match). */
  bumpVersion(id: string, bytes = Buffer.from('another device saved first')): void {
    this.docs.get(id)!.versions.push(bytes)
  }

  hardDelete(id: string): void {
    this.docs.delete(id)
  }
}

/** Minimal multipart parse (fields + the one file part). */
async function parseMultipart(
  init: RequestInit | undefined,
): Promise<{ fields: Record<string, string>; file: Buffer }> {
  const form = await new Request('http://mock.local/documents', {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  }).formData()
  const fields: Record<string, string> = {}
  let file = Buffer.alloc(0)
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value
    else file = Buffer.from(await value.arrayBuffer())
  }
  return { fields, file }
}

// ── fixtures ──────────────────────────────────────────────────────────────

let root: string
let backend: FakeBackend
let mode: StorageMode
let signedIn: boolean
let router: DocumentStoreRouter
let exitWipe: (() => void) | undefined
let documentsDir: string
let localRoot: string
let scratchDir: string
let indexPath: string
const rekeyTabs = vi.fn()
const rekeyRegistry = vi.fn()
const cloudIdMinted = vi.fn()
/** registry-shaped lookup over the backend's seeded documents */
let entries: CloudDocumentEntry[]

const entryOf = (cloudId: string, over: Partial<CloudDocumentEntry> = {}): CloudDocumentEntry => ({
  cloudId,
  name: `${cloudId}.docx`,
  kind: 'docx',
  sizeBytes: 10,
  currentVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  starred: false,
  lastOpenedAt: null,
  ...over,
})

function makeRouter(): DocumentStoreRouter {
  // the registry seam is typed as CloudDocumentsRegistry; a structural
  // stand-in keeps this test free of the real registry's disk cache
  const fakeRegistry = {
    document: (cloudId: string): CloudDocumentEntry | undefined =>
      entries.find((e) => e.cloudId === cloudId),
    rekeyDocument: rekeyRegistry,
  } as unknown as DocumentStoreRouterDeps['registry'] extends () => infer R | undefined ? R : never
  const deps: DocumentStoreRouterDeps = {
    mode: () => mode,
    sessionActive: () => signedIn,
    // the shared client's shape: no session → no client → transport failure
    transport: async (path, init) => {
      if (!signedIn) throw new TypeError('no session')
      return backend.transport(path, init)
    },
    localRootDir: localRoot,
    scratchDir,
    indexPath,
    documentsDir: () => documentsDir,
    registry: () => fakeRegistry,
    rekeyTabs,
    onCloudIdMinted: cloudIdMinted,
    onExit: (wipe) => {
      exitWipe = wipe
    },
  }
  return new DocumentStoreRouter(deps)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ds-router-'))
  backend = new FakeBackend()
  mode = 'local'
  signedIn = false
  exitWipe = undefined
  localRoot = join(root, 'userData')
  scratchDir = join(localRoot, 'cloud-scratch')
  documentsDir = join(root, 'documents')
  indexPath = join(localRoot, 'cloud-document-index.json')
  entries = []
  rekeyTabs.mockClear()
  rekeyRegistry.mockClear()
  cloudIdMinted.mockClear()
  mkdirSync(documentsDir, { recursive: true })
  router = makeRouter()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const localFile = (name: string, bytes = Buffer.from('local bytes')): string => {
  const path = join(documentsDir, name)
  writeFileSync(path, bytes)
  return path
}

/** The cloudId the association index records for a path. */
const associationOf = (path: string): string =>
  (
    JSON.parse(readFileSync(indexPath, 'utf8')) as {
      documents: Record<string, { cloudId: string }>
    }
  ).documents[path]!.cloudId

/** The index persists fire-and-forget; let that write land before reading it. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('routing: the mode × session matrix', () => {
  it('picks the adapter per mode and session', () => {
    mode = 'local'
    expect(router.activeStore()).toBe(router.localStore)
    mode = 'remote'
    expect(router.activeStore()).toBe(router.localStore) // signed out: fallback
    mode = 'hybrid'
    expect(router.activeStore()).toBe(router.localStore)
    signedIn = true
    mode = 'remote'
    expect(router.activeStore()).toBe(router.remoteStore)
    mode = 'hybrid'
    expect(router.activeStore()).toBe(router.hybridStore)
    mode = 'local'
    expect(router.activeStore()).toBe(router.localStore)
  })

  it('writes a local-mode document to disk and never to the server', async () => {
    const path = join(documentsDir, 'a.docx')
    await router.write({ path }, Buffer.from('local only'))
    expect(existsSync(path)).toBe(true)
    expect(backend.requests).toEqual([])
  })

  it('uploads a remote-mode save and writes no local file', async () => {
    signedIn = true
    mode = 'remote'
    const path = join(documentsDir, 'b.docx')
    await router.write({ path }, Buffer.from('server copy'))
    expect(existsSync(path)).toBe(false)
    expect(backend.requests).toEqual([{ method: 'POST', path: '/documents', ifMatch: undefined }])
  })

  it('writes the local file AND mirrors it in hybrid mode', async () => {
    signedIn = true
    mode = 'hybrid'
    const path = join(documentsDir, 'c.docx')
    await router.write({ path }, Buffer.from('both'))
    expect(readFileSync(path, 'utf8')).toBe('both')
    expect(backend.requests.map((r) => r.method)).toEqual(['POST'])
  })
})

describe('pinning: open tabs keep their store', () => {
  it('keeps routing a remote-opened document through the server after a mode switch', async () => {
    signedIn = true
    mode = 'remote'
    const path = join(documentsDir, 'pinned.docx')
    await router.write({ path }, Buffer.from('v1')) // POST: pinned to remote
    const cloudId = associationOf(path)

    mode = 'local' // the user switches; the tab stays open
    await router.write({ path }, Buffer.from('v2'))
    const [post, put] = backend.requests
    expect(post.method).toBe('POST')
    expect(put.method).toBe('PUT') // still the pinned remote adapter
    expect(put.path).toBe(`/documents/${cloudId}`)
    expect(backend.bytesOf(cloudId).toString()).toBe('v2')
  })

  it('keeps routing an associated hybrid document through the mirror after a restart', async () => {
    signedIn = true
    mode = 'hybrid'
    const path = localFile('resume.docx', Buffer.from('v1'))
    await router.write({ path }, Buffer.from('v2'))
    const cloudId = associationOf(path)

    // the "restart": a fresh router over the same persisted index
    router = makeRouter()
    await router.write({ path }, Buffer.from('v3'))
    const [post, put] = backend.requests
    expect(post.method).toBe('POST')
    expect(put.method).toBe('PUT') // no second document was minted
    expect(put.path).toBe(`/documents/${cloudId}`)
  })

  it('re-issues write grants under the minted id (the second save is not refused)', async () => {
    signedIn = true
    mode = 'remote'
    const path = join(documentsDir, 'grants.docx')
    router.authorizeWrite(7, { path })
    await expect(router.canWrite(7, { path })).resolves.toBe(true)
    await router.write({ path }, Buffer.from('first')) // mints the cloud id
    await expect(router.canWrite(7, { path })).resolves.toBe(true)
    await router.write({ path }, Buffer.from('second'))
    expect(backend.requests.filter((r) => r.method === 'PUT')).toHaveLength(1)
  })
})

describe('logout fallback and read-only-until-signin', () => {
  it('an unassociated local document keeps working after sign-out', async () => {
    signedIn = true
    mode = 'hybrid'
    const path = localFile('plain.docx')
    await router.write({ path }, Buffer.from('v1')) // associated + mirrored
    signedIn = false // logout: routing falls back to local behavior
    await router.write({ path }, Buffer.from('v2'))
    expect(readFileSync(path, 'utf8')).toBe('v2') // the local write landed
  })

  it('a remote-pinned document fails its save without a session (read-only-until-signin)', async () => {
    signedIn = true
    mode = 'remote'
    const path = join(documentsDir, 'cloud-only.docx')
    await router.write({ path }, Buffer.from('v1'))
    signedIn = false // the transport has no client without a session
    await expect(router.write({ path }, Buffer.from('v2'))).rejects.toThrow()
    expect(backend.bytesOf(associationOf(path)).toString()).toBe('v1')
  })
})

describe('per-mode autosave (crash recovery)', () => {
  it('remote-routed recovery PUTs a server version and writes no local buffer', async () => {
    signedIn = true
    mode = 'remote'
    const path = join(documentsDir, 'autosave.docx')
    await router.write({ path }, Buffer.from('v1'))
    const cloudId = associationOf(path)
    await router.writeRecovery({ path }, Buffer.from('unsaved work'))
    const puts = backend.requests.filter((r) => r.method === 'PUT')
    expect(puts).toHaveLength(1) // the recovery tick WAS the server autosave
    expect(backend.bytesOf(cloudId).toString()).toBe('unsaved work')
    expect(router.remoteStore.scratch.tracked()).toEqual([]) // no local buffer
  })

  it('local-routed recovery keeps today’s recovery-copy semantics', async () => {
    const path = localFile('recover.docx')
    await router.writeRecovery({ path }, Buffer.from('buffer'))
    expect(router.recoveryStamp({ path })).not.toBeNull()
    await expect(router.readRecovery({ path })).resolves.toEqual(Buffer.from('buffer'))
  })
})

describe('scratch lifecycle (remote mode)', () => {
  const openRemote = async (cloudId: string): Promise<string> => {
    mode = 'remote'
    signedIn = true
    const outcome = await router.openCloudDocument(cloudId)
    if (!outcome.ok) throw new Error(`open failed: ${JSON.stringify(outcome)}`)
    if (outcome.plan.kind !== 'remote') throw new Error('expected a remote plan')
    return outcome.plan.path
  }

  it('plans a scratch path, downloads into it on read, and wipes it on exit', async () => {
    const cloudId = backend.seed('report.docx', 'docx', Buffer.from('the doc'))
    entries = [entryOf(cloudId, { name: 'report.docx' })]
    const path = await openRemote(cloudId)
    expect(path.startsWith(scratchDir)).toBe(true)
    expect(/\.docx$/.test(path)).toBe(true)
    expect(existsSync(path)).toBe(false) // nothing is written until it is read

    await expect(router.read({ path })).resolves.toEqual(Buffer.from('the doc'))
    expect(existsSync(path)).toBe(true) // the scratch twin landed
    expect(existsSync(indexPath)).toBe(true) // the association persists

    await router.wipeScratch() // the shell's will-quit hook
    expect(existsSync(path)).toBe(false)
  })

  it('drops the scratch file and the routing entry when the last owner closes', async () => {
    const cloudId = backend.seed('gone.docx', 'docx', Buffer.from('gone'))
    entries = [entryOf(cloudId, { name: 'gone.docx' })]
    const path = await openRemote(cloudId)
    router.authorizeWrite(11, { path })
    await router.read({ path })
    router.forgetOwner(11) // the tab closed
    expect(existsSync(path)).toBe(false)
    expect(router.isScratchPath(path)).toBe(true)
    expect(router.isCloudOnlyPath(path)).toBe(true)
  })

  it('registers the exit wipe and it clears tracked scratch files', async () => {
    const cloudId = backend.seed('exit.docx', 'docx', Buffer.from('exit'))
    entries = [entryOf(cloudId, { name: 'exit.docx' })]
    const path = await openRemote(cloudId)
    await router.read({ path })
    expect(exitWipe).toBeDefined()
    exitWipe!()
    expect(existsSync(path)).toBe(false)
  })

  it('sweepStaleScratch removes files a crashed run left behind', () => {
    const stale = join(scratchDir, 'genoffice-stale-1.docx')
    mkdirSync(scratchDir, { recursive: true })
    writeFileSync(stale, Buffer.from('crash leftover'))
    router.sweepStaleScratch()
    expect(existsSync(stale)).toBe(false)
  })
})

describe('open-from-cloud, both modes', () => {
  it('remote mode: scratch-backed plan carrying the cloudId and the server name', async () => {
    mode = 'remote'
    signedIn = true
    const cloudId = backend.seed('Notes', 'docx', Buffer.from('notes'))
    entries = [entryOf(cloudId, { name: 'Notes' })]
    const outcome = await router.openCloudDocument(cloudId)
    expect(outcome).toEqual({
      ok: true,
      plan: { kind: 'remote', cloudId, path: expect.any(String), name: 'Notes.docx' },
    })
  })

  it('hybrid mode: downloads into the documents folder and later saves mirror the same id', async () => {
    mode = 'hybrid'
    signedIn = true
    const cloudId = backend.seed('shared.docx', 'docx', Buffer.from('downloaded'))
    entries = [entryOf(cloudId, { name: 'shared.docx' })]
    const outcome = await router.openCloudDocument(cloudId)
    expect(outcome.ok && outcome.plan.kind === 'local' && outcome.plan.name).toBe('shared.docx')
    const path = outcome.ok && outcome.plan.kind === 'local' ? outcome.plan.path : ''
    expect(path.startsWith(documentsDir)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('downloaded')
    // the tab saves: the mirror updates the SAME server document
    router.authorizeWrite(3, { path })
    await router.write({ path }, Buffer.from('edited'))
    const requests = backend.requests.map((r) => `${r.method} ${r.path}`)
    expect(requests).toEqual([`GET /documents/${cloudId}`, `PUT /documents/${cloudId}`])
    expect(backend.bytesOf(cloudId).toString()).toBe('edited')
  })

  it('local mode: a plain copy with no association (a later save mints its own)', async () => {
    mode = 'local'
    signedIn = true
    const cloudId = backend.seed('copy.docx', 'docx', Buffer.from('plain copy'))
    entries = [entryOf(cloudId, { name: 'copy.docx' })]
    const outcome = await router.openCloudDocument(cloudId)
    const path = outcome.ok && outcome.plan.kind === 'local' ? outcome.plan.path : ''
    expect(readFileSync(path, 'utf8')).toBe('plain copy')
    await router.write({ path }, Buffer.from('local edit'))
    // local mode never talks to the server: the edit stayed in the local file
    expect(backend.requests.map((r) => r.method)).toEqual(['GET'])
    expect(readFileSync(path, 'utf8')).toBe('local edit')
  })

  it('name collisions on download get unique-suffixed local names', async () => {
    mode = 'hybrid'
    signedIn = true
    const a = backend.seed('same.docx', 'docx', Buffer.from('a'))
    const b = backend.seed('same.docx', 'docx', Buffer.from('b'))
    entries = [entryOf(a, { name: 'same.docx' }), entryOf(b, { name: 'same.docx' })]
    const first = await router.openCloudDocument(a)
    const second = await router.openCloudDocument(b)
    const p1 = first.ok && first.plan.kind === 'local' ? first.plan.path : ''
    const p2 = second.ok && second.plan.kind === 'local' ? second.plan.path : ''
    expect(p1).not.toBe(p2)
    expect([p1, p2].sort()).toEqual([
      join(documentsDir, 'same-2.docx'),
      join(documentsDir, 'same.docx'),
    ])
    expect(readFileSync(p1, 'utf8')).toBe('a')
    expect(readFileSync(p2, 'utf8')).toBe('b')
  })

  it('a re-open of the same document reuses its download target (no -3, -4 copies)', async () => {
    mode = 'hybrid'
    signedIn = true
    const cloudId = backend.seed('again.docx', 'docx', Buffer.from('again'))
    entries = [entryOf(cloudId, { name: 'again.docx' })]
    const first = await router.openCloudDocument(cloudId)
    const again = await router.openCloudDocument(cloudId)
    expect(
      first.ok && first.plan.kind === 'local' && again.ok && again.plan.kind === 'local'
        ? first.plan.path === again.plan.path
        : false,
    ).toBe(true)
  })

  it('answers the typed errors: sign-in-required, unsupported-kind, not-found', async () => {
    mode = 'remote'
    signedIn = false
    const cloudId = backend.seed('x.docx', 'docx', Buffer.from('x'))
    entries = [entryOf(cloudId)]
    await expect(router.openCloudDocument(cloudId)).resolves.toEqual({
      ok: false,
      error: 'sign-in-required',
    })
    signedIn = true
    const sheet = backend.seed('sheet.xlsx', 'xlsx', Buffer.from('x'))
    entries = [entryOf(cloudId), entryOf(sheet, { name: 'sheet.xlsx', kind: 'xlsx' })]
    await expect(router.openCloudDocument(sheet)).resolves.toEqual({
      ok: false,
      error: 'unsupported-kind',
    })
    await expect(router.openCloudDocument('nope')).resolves.toEqual({
      ok: false,
      error: 'not-found',
    })
  })

  it('a dead transport answers unavailable (the download failed)', async () => {
    mode = 'hybrid'
    signedIn = true
    backend.dead = true
    const cloudId = backend.seed('dead.docx', 'docx', Buffer.from('dead'))
    entries = [entryOf(cloudId, { name: 'dead.docx' })]
    await expect(router.openCloudDocument(cloudId)).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    })
  })
})

describe('cloudId re-points fan out (the Task 14 carry-over)', () => {
  it('a conflict copy re-keys the registry entry and the open tabs', async () => {
    signedIn = true
    mode = 'hybrid'
    const path = localFile('conflict.docx')
    await router.write({ path }, Buffer.from('mine v1'))
    const cloudId = associationOf(path)
    backend.bumpVersion(cloudId) // another device wins the race

    await router.write({ path }, Buffer.from('mine v2')) // 409 → conflict copy

    expect(rekeyRegistry).toHaveBeenCalledTimes(1)
    const [oldId, newId] = rekeyRegistry.mock.calls[0] as [string, string]
    expect(oldId).toBe(cloudId)
    expect(newId).not.toBe(cloudId)
    expect(rekeyTabs).toHaveBeenCalledWith(oldId, newId)
    // the association followed the copy: the next save updates it
    await router.write({ path }, Buffer.from('mine v3'))
    const lastPut = backend.requests.filter((r) => r.method === 'PUT').at(-1)!
    expect(lastPut.path).toBe(`/documents/${newId}`)
  })

  it('a minted id is reported once (the shell binds the tab identity)', async () => {
    signedIn = true
    mode = 'remote'
    const path = join(documentsDir, 'minted.docx')
    await router.write({ path }, Buffer.from('first'))
    expect(cloudIdMinted).toHaveBeenCalledTimes(1)
    expect(typeof cloudIdMinted.mock.calls[0]![1]).toBe('string')
    await router.write({ path }, Buffer.from('second')) // same id: no re-report
    expect(cloudIdMinted).toHaveBeenCalledTimes(1)
  })
})

describe('the association index', () => {
  it('records one path per cloudId (a re-download replaces the older binding)', async () => {
    mode = 'hybrid'
    signedIn = true
    const cloudId = backend.seed('dup.docx', 'docx', Buffer.from('dup'))
    entries = [entryOf(cloudId, { name: 'dup.docx' })]
    const first = await router.openCloudDocument(cloudId)
    const p1 = first.ok && first.plan.kind === 'local' ? first.plan.path : ''
    await settle()
    // the session's download-target cache is the only thing pinning p1; a
    // fresh router (app restart) lands a collision-suffixed second name
    router = makeRouter()
    const second = await router.openCloudDocument(cloudId)
    const p2 = second.ok && second.plan.kind === 'local' ? second.plan.path : ''
    expect(p2).not.toBe(p1)
    const stored = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      documents: Record<string, { cloudId: string }>
    }
    expect(Object.keys(stored.documents)).toEqual([p2])
    expect(stored.documents[p2]!.cloudId).toBe(cloudId)
  })

  it('a server-side delete drops the association only for remote-routed removals', async () => {
    signedIn = true
    mode = 'remote'
    const path = join(documentsDir, 'bye.docx')
    await router.write({ path }, Buffer.from('bye'))
    const cloudId = associationOf(path)
    await router.remove({ path })
    const stored = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      documents: Record<string, unknown>
    }
    expect(stored.documents[path]).toBeUndefined()
    expect(backend.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/documents/${cloudId}`,
    })
  })

  it('a rename re-keys the association and the routing entry', async () => {
    signedIn = true
    mode = 'hybrid'
    const path = localFile('rename.docx')
    await router.write({ path }, Buffer.from('v1'))
    const cloudId = associationOf(path)
    const renamed = join(documentsDir, 'renamed.docx')
    router.renameOwnerPath(5, path, renamed)
    const stored = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      documents: Record<string, { cloudId: string }>
    }
    expect(stored.documents[renamed]!.cloudId).toBe(cloudId)
    expect(stored.documents[path]).toBeUndefined()
    await router.write({ path }, Buffer.from('stale')) // the old path is new again
    expect(backend.requests.filter((r) => r.method === 'POST')).toHaveLength(2)
  })

  it('a corrupt index file reads as empty (every document mints fresh)', () => {
    mkdirSync(localRoot, { recursive: true })
    writeFileSync(indexPath, 'not json')
    const fresh = makeRouter()
    expect(fresh.activeStore()).toBe(fresh.localStore) // constructed without throwing
  })
})

describe('plain local files in cloud modes', () => {
  it('opens and reads a real local file through the local adapter while remote is active', async () => {
    mode = 'remote'
    signedIn = true
    const path = localFile('existing.docx', Buffer.from('from disk'))
    await expect(router.read({ path })).resolves.toEqual(Buffer.from('from disk'))
    expect(backend.requests).toEqual([]) // nothing was asked of the server
    router.authorizeWrite(9, { path })
    await expect(router.canWrite(9, { path })).resolves.toBe(true)
  })

  it('the first save of that file uploads it (remote mode upload-on-save)', async () => {
    mode = 'remote'
    signedIn = true
    const path = localFile('upload-me.docx', Buffer.from('local original'))
    await router.write({ path }, Buffer.from('edited'))
    expect(backend.requests).toEqual([{ method: 'POST', path: '/documents' }])
    expect(readFileSync(path, 'utf8')).toBe('local original') // remote keeps no local copy
  })
})

describe('migration units', () => {
  it('uploadDocument in hybrid mode mirrors without rewriting the working copy', async () => {
    mode = 'hybrid'
    signedIn = true
    const path = localFile('migrate.docx', Buffer.from('working copy'))
    const before = statSync(path).mtimeMs
    await new Promise((r) => setTimeout(r, 5))
    await router.uploadDocument(path)
    expect(statSync(path).mtimeMs).toBe(before) // the open tab's baseline holds
    expect(backend.requests.map((r) => r.method)).toEqual(['POST'])
    expect(backend.requests[0]!.ifMatch).toBeUndefined()
  })

  it('uploadDocument in remote mode uploads and keeps the association', async () => {
    mode = 'remote'
    signedIn = true
    const path = localFile('migrate-remote.docx')
    await router.uploadDocument(path)
    const cloudId = associationOf(path)
    expect(backend.bytesOf(cloudId).toString()).toBe('local bytes')
  })
})
