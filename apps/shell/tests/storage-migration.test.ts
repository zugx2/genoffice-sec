/**
 * `runStorageMigration` / `migrationOfferFor` (src/main/auth/storage-migration.ts,
 * Phase 7e): the bulk mode-switch move's unit behavior — step enumeration per
 * direction, the per-step progress pushes, the failure-code mapping and the
 * failures list, retry-by-`source` handles, mid-run failures staying
 * non-fatal, and the offer matrix — plus one integration check that a
 * download run lands same-named server documents at unique suffixed paths
 * through the real router (the collision authority is the local filesystem).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RemoteDocumentApiError,
  RemoteDocumentNotFoundError,
  RemoteDocumentUnavailableError,
} from '@genoffice/document-store'
import type { CloudDocumentEntry } from '../src/shared/cloud-docs-api'
import type { MigrationProgressPayload } from '../src/shared/storage-mode-api'
import {
  localNameForDocument,
  migrationOfferFor,
  runStorageMigration,
  uploadableLocalDocuments,
} from '../src/main/auth/storage-migration'
import type { StorageMigrationDeps } from '../src/main/auth/storage-migration'
import { DocumentStoreRouter } from '../src/main/auth/document-store-router'

// ── harness (every dep injected, every outcome scriptable) ───────────────

const entry = (cloudId: string, over: Partial<CloudDocumentEntry> = {}): CloudDocumentEntry => ({
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

interface MigrationHarness {
  deps: StorageMigrationDeps
  /** every progress push, in order */
  progress: MigrationProgressPayload[]
  /** every upload ATTEMPT (failures included), in order */
  uploadAttempts: string[]
  /** every download ATTEMPT (failures included), in order */
  downloadAttempts: Array<{ cloudId: string; name: string }>
  failUploads: (path: string, error: unknown) => void
  failDownloads: (cloudId: string, error: unknown) => void
  /** clears a scripted failure (the retry succeeds) */
  healUploads: (path: string) => void
  healDownloads: (cloudId: string) => void
}

function makeHarness(over: Partial<StorageMigrationDeps> = {}): MigrationHarness {
  const progress: MigrationProgressPayload[] = []
  const uploadAttempts: string[] = []
  const downloadAttempts: Array<{ cloudId: string; name: string }> = []
  const uploadFailures = new Map<string, unknown>()
  const downloadFailures = new Map<string, unknown>()
  const harness: MigrationHarness = {
    progress,
    uploadAttempts,
    downloadAttempts,
    failUploads: (path, error) => {
      uploadFailures.set(path, error)
    },
    failDownloads: (cloudId, error) => {
      downloadFailures.set(cloudId, error)
    },
    healUploads: (path) => {
      uploadFailures.delete(path)
    },
    healDownloads: (cloudId) => {
      downloadFailures.delete(cloudId)
    },
    deps: {
      sessionActive: () => true,
      documentsDir: () => '/docs',
      listLocalDocuments: () => [],
      cloudDocuments: () => [],
      upload: async (path: string) => {
        uploadAttempts.push(path)
        const failure = uploadFailures.get(path)
        if (failure !== undefined) throw failure
      },
      download: async (cloudId: string, name: string) => {
        downloadAttempts.push({ cloudId, name })
        const failure = downloadFailures.get(cloudId)
        if (failure !== undefined) throw failure
        return { ok: true, path: join('/docs', name) }
      },
      onProgress: (payload) => {
        progress.push(payload)
      },
      ...over,
    },
  }
  return harness
}

const offerDeps = {
  documentsDir: () => '/docs',
  listLocalDocuments: () => ['/docs/a.docx', '/docs/b.md'],
  cloudDocuments: () => [entry('id-1'), entry('id-2'), entry('id-3')],
}

// ── step enumeration + progress ───────────────────────────────────────────

describe('step enumeration and progress', () => {
  it('upload runs one step per uploadable local document and pushes one progress event each', async () => {
    const paths = [
      '/docs/report.docx',
      '/docs/notes.md',
      '/docs/photo.png', // not a documents-API kind
      '/docs/plain', // no extension
      '/docs/deep/nested/old.DOCX', // the extension check is case-insensitive
      '/docs/deep/nested/spec.pdf',
    ]
    expect(uploadableLocalDocuments(paths)).toEqual([
      '/docs/report.docx',
      '/docs/notes.md',
      '/docs/deep/nested/old.DOCX',
      '/docs/deep/nested/spec.pdf',
    ])
    const h = makeHarness({ listLocalDocuments: () => paths })
    await expect(runStorageMigration(h.deps, 'upload')).resolves.toEqual({
      ok: true,
      moved: 4,
      failures: [],
    })
    expect(h.uploadAttempts).toEqual([
      '/docs/report.docx',
      '/docs/notes.md',
      '/docs/deep/nested/old.DOCX',
      '/docs/deep/nested/spec.pdf',
    ])
    expect(h.progress.map((p) => [p.done, p.total, p.current])).toEqual([
      [1, 4, 'report.docx'],
      [2, 4, 'notes.md'],
      [3, 4, 'old.DOCX'],
      [4, 4, 'spec.pdf'],
    ])
    expect(h.progress.every((p) => p.failures.length === 0)).toBe(true)
  })

  it('download runs one step per server document under its local name', async () => {
    const h = makeHarness({
      cloudDocuments: () => [
        entry('id-1', { name: 'Notes' }),
        entry('id-2', { name: '报告.docx' }),
      ],
    })
    await expect(runStorageMigration(h.deps, 'download')).resolves.toEqual({
      ok: true,
      moved: 2,
      failures: [],
    })
    // the extension-less server name gets the one its kind implies
    expect(h.downloadAttempts).toEqual([
      { cloudId: 'id-1', name: 'Notes.docx' },
      { cloudId: 'id-2', name: '报告.docx' },
    ])
    expect(h.progress.map((p) => [p.done, p.total, p.current])).toEqual([
      [1, 2, 'Notes.docx'],
      [2, 2, '报告.docx'],
    ])
  })

  it('refuses to start without a session (nothing runs, nothing is pushed)', async () => {
    const h = makeHarness({ sessionActive: () => false })
    await expect(runStorageMigration(h.deps, 'upload')).resolves.toEqual({
      ok: false,
      error: 'sign-in-required',
    })
    await expect(runStorageMigration(h.deps, 'download')).resolves.toEqual({
      ok: false,
      error: 'sign-in-required',
    })
    expect(h.uploadAttempts).toEqual([])
    expect(h.downloadAttempts).toEqual([])
    expect(h.progress).toEqual([])
  })
})

// ── failures ──────────────────────────────────────────────────────────────

describe('failures', () => {
  it('maps each failure to its stable code and lists it with name + retry source', async () => {
    const h = makeHarness({
      listLocalDocuments: () => [
        '/docs/a.docx',
        '/docs/b.docx',
        '/docs/c.docx',
        '/docs/d.docx',
        '/docs/e.docx',
      ],
    })
    h.failUploads('/docs/a.docx', new RemoteDocumentNotFoundError()) // server 404
    h.failUploads('/docs/b.docx', new RemoteDocumentUnavailableError('fetch failed')) // network
    h.failUploads('/docs/c.docx', new RemoteDocumentApiError('bad request', { status: 400 })) // 4xx
    h.failUploads('/docs/d.docx', Object.assign(new Error('gone'), { code: 'ENOENT' })) // vanished file
    h.failUploads('/docs/e.docx', new Error('kaboom')) // unknown
    const result = await runStorageMigration(h.deps, 'upload')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.moved).toBe(0)
    expect(result.failures).toEqual([
      { name: 'a.docx', error: 'not-found', source: '/docs/a.docx' },
      { name: 'b.docx', error: 'unavailable', source: '/docs/b.docx' },
      { name: 'c.docx', error: 'unavailable', source: '/docs/c.docx' },
      { name: 'd.docx', error: 'read-failed', source: '/docs/d.docx' },
      { name: 'e.docx', error: 'write-failed', source: '/docs/e.docx' },
    ])
  })

  it('a mid-run failure does not abort the remaining steps (failures accumulate in progress)', async () => {
    const h = makeHarness({ cloudDocuments: () => [entry('id-1'), entry('id-2'), entry('id-3')] })
    h.failDownloads('id-2', new RemoteDocumentUnavailableError('offline'))
    await expect(runStorageMigration(h.deps, 'download')).resolves.toEqual({
      ok: true,
      moved: 2,
      failures: [{ name: 'id-2.docx', error: 'unavailable', source: 'id-2' }],
    })
    // all three steps ran, in order, despite the middle one failing
    expect(h.downloadAttempts.map((d) => d.cloudId)).toEqual(['id-1', 'id-2', 'id-3'])
    // and each push carries the failures so far (the list grows monotonically)
    expect(h.progress.map((p) => [p.done, p.failures.length])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
    ])
    expect(h.progress[2]!.failures[0]).toMatchObject({ name: 'id-2.docx', source: 'id-2' })
  })
})

// ── retry ─────────────────────────────────────────────────────────────────

describe('retry by source handle', () => {
  it('an upload retry re-runs only the failed steps (a succeeded document is never re-copied)', async () => {
    const h = makeHarness({
      listLocalDocuments: () => ['/docs/keep.docx', '/docs/broken.docx'],
    })
    h.failUploads('/docs/broken.docx', new Error('first attempt failed'))
    const first = await runStorageMigration(h.deps, 'upload')
    expect(first).toMatchObject({ ok: true, moved: 1 })
    expect(h.uploadAttempts).toEqual(['/docs/keep.docx', '/docs/broken.docx'])
    const sources = first.ok ? first.failures.map((f) => f.source) : []
    expect(sources).toEqual(['/docs/broken.docx'])

    h.healUploads('/docs/broken.docx') // the retry succeeds
    const second = await runStorageMigration(h.deps, 'upload', sources)
    expect(second).toEqual({ ok: true, moved: 1, failures: [] })
    // exactly one new attempt — the succeeded document was not re-uploaded
    // (an upload re-run would mint a server duplicate)
    expect(h.uploadAttempts).toEqual(['/docs/keep.docx', '/docs/broken.docx', '/docs/broken.docx'])
    // the retry run's totals cover the retry list only
    expect(h.progress.slice(2)).toEqual([
      { done: 1, total: 1, current: 'broken.docx', failures: [] },
    ])
  })

  it('a download retry addresses the failed cloud ids and updates the totals', async () => {
    const h = makeHarness({ cloudDocuments: () => [entry('id-1'), entry('id-2')] })
    h.failDownloads('id-2', new RemoteDocumentApiError('gone', { status: 404 }))
    const first = await runStorageMigration(h.deps, 'download')
    const sources = first.ok ? first.failures.map((f) => f.source) : []
    expect(sources).toEqual(['id-2'])

    h.healDownloads('id-2') // the retry succeeds
    const second = await runStorageMigration(h.deps, 'download', sources)
    expect(second).toEqual({ ok: true, moved: 1, failures: [] })
    expect(h.downloadAttempts.map((d) => d.cloudId)).toEqual(['id-1', 'id-2', 'id-2'])
    expect(h.progress.at(-1)).toMatchObject({ total: 1, done: 1, current: 'id-2.docx' })
  })

  it('a retry handle whose file has since vanished fails its step again (listed, never skipped)', async () => {
    const h = makeHarness()
    h.failUploads('/docs/gone.docx', Object.assign(new Error('no such file'), { code: 'ENOENT' }))
    await expect(runStorageMigration(h.deps, 'upload', ['/docs/gone.docx'])).resolves.toEqual({
      ok: true,
      moved: 0,
      failures: [{ name: 'gone.docx', error: 'read-failed', source: '/docs/gone.docx' }],
    })
  })
})

// ── the offer matrix ──────────────────────────────────────────────────────

describe('migrationOfferFor', () => {
  it('offers upload for local → cloud switches, download for remote → local switches', () => {
    expect(migrationOfferFor('local', 'remote', offerDeps)).toEqual({
      direction: 'upload',
      count: 2,
    })
    expect(migrationOfferFor('local', 'hybrid', offerDeps)).toEqual({
      direction: 'upload',
      count: 2,
    })
    expect(migrationOfferFor('remote', 'local', offerDeps)).toEqual({
      direction: 'download',
      count: 3,
    })
    expect(migrationOfferFor('remote', 'hybrid', offerDeps)).toEqual({
      direction: 'download',
      count: 3,
    })
  })

  it('offers nothing for hybrid → anything and for same-mode no-ops', () => {
    // hybrid's working copies are already local and mirrored: nothing to move
    expect(migrationOfferFor('hybrid', 'local', offerDeps)).toBeNull()
    expect(migrationOfferFor('hybrid', 'remote', offerDeps)).toBeNull()
    for (const mode of ['local', 'remote', 'hybrid'] as const) {
      expect(migrationOfferFor(mode, mode, offerDeps)).toBeNull()
    }
  })
})

// ── display names ─────────────────────────────────────────────────────────

describe('localNameForDocument', () => {
  it('sanitizes hostile server names and implies the extension from the kind', () => {
    expect(localNameForDocument(entry('x', { name: 'Notes' }))).toBe('Notes.docx')
    expect(localNameForDocument(entry('x', { name: 'a/b\\c:d*e' }))).toBe('a_b_c_d_e.docx')
    expect(localNameForDocument(entry('x', { name: '  ' }))).toBe('document.docx')
    expect(localNameForDocument(entry('x', { name: 'keep.md', kind: 'md' }))).toBe('keep.md')
    // a dotted name is trusted even when the "extension" is not a real kind
    expect(localNameForDocument(entry('x', { name: 'no.kind', kind: 'docx' }))).toBe('no.kind')
  })
})

// ── collisions through the real router ────────────────────────────────────

describe('download runs against the real router', () => {
  let rootDir = ''

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'storage-migration-'))
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('a download run lands same-named server documents at unique suffixed paths', async () => {
    const documentsDir = join(rootDir, 'documents')
    mkdirSync(documentsDir, { recursive: true })
    const stored = new Map<string, Buffer>([
      ['dup-1', Buffer.from('first')],
      ['dup-2', Buffer.from('second')],
    ])
    const router = new DocumentStoreRouter({
      mode: () => 'local',
      sessionActive: () => true,
      transport: async (path) => {
        const match = /^\/documents\/([^/?]+)$/.exec(path)
        const bytes =
          match !== null ? stored.get(decodeURIComponent(match[1] as string)) : undefined
        if (bytes === undefined) {
          return Response.json({ error: { code: 'not_found' } }, { status: 404 })
        }
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { etag: '1' },
        })
      },
      localRootDir: join(rootDir, 'userData'),
      scratchDir: join(rootDir, 'userData', 'cloud-scratch'),
      indexPath: join(rootDir, 'userData', 'cloud-document-index.json'),
      documentsDir: () => documentsDir,
      onExit: () => {},
    })
    const h = makeHarness({
      documentsDir: () => documentsDir,
      cloudDocuments: () => [
        entry('dup-1', { name: 'same.docx' }),
        entry('dup-2', { name: 'same.docx' }),
      ],
      download: (cloudId, name) => router.downloadDocument(cloudId, name),
    })
    // the migration's own unit behavior is unchanged; the collision handling
    // lives in the router's downloadDocument (the local filesystem decides)
    await expect(runStorageMigration(h.deps, 'download')).resolves.toEqual({
      ok: true,
      moved: 2,
      failures: [],
    })
    expect(readFileSync(join(documentsDir, 'same.docx'), 'utf8')).toBe('first')
    expect(readFileSync(join(documentsDir, 'same-2.docx'), 'utf8')).toBe('second')
    expect(h.progress.map((p) => p.current)).toEqual(['same.docx', 'same.docx'])
  })
})
