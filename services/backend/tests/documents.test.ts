/**
 * Unit suite for the document endpoints (Phase 7a).
 *
 * Same harness conventions as projects-chats.test.ts: real RS256 tokens
 * minted locally, a real HTTP JWKS server, the real `verifyAuth` plugin, and
 * the real SQLite store on an in-memory database — plus a throwaway data
 * directory for the byte store, so the on-disk layout (per-`sub` trees,
 * `<docId>/<version>` files, pruning) is asserted directly. A second app
 * instance with a 1 KiB upload cap exercises the 413 path without
 * allocating the production 200 MiB.
 *
 * Isolation is checked on both halves: user B must never see A's metadata
 * (list/versions) nor reach A's bytes (GET/PUT/DELETE), and the byte tree
 * itself must be keyed by `sub` — including a hostile `sub` carrying path
 * separators, which must land in one encoded directory, not escape it.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { generateTestKey, JwksTestServer, type TestKey } from './helpers/jwks-server.js'
import { signAccessToken } from './helpers/tokens.js'

const ISSUER = 'https://auth.test/realms/genoffice'
const AUDIENCE = 'genoffice-backend'
/** Upload cap for the dedicated 413 app (production default is 200 MiB). */
const SMALL_CAP = 1024

let jwks: JwksTestServer
let key: TestKey
let app: FastifyInstance
let cappedApp: FastifyInstance
let dataDir: string
let cappedDataDir: string
let tokenA: string
let tokenB: string
let tokenHostile: string

beforeAll(async () => {
  jwks = await JwksTestServer.start()
  key = await generateTestKey('kid-a')
  jwks.setKeys([key])
  dataDir = mkdtempSync(join(tmpdir(), 'genoffice-docs-'))
  cappedDataDir = mkdtempSync(join(tmpdir(), 'genoffice-docs-capped-'))
  const baseConfig = {
    port: 0,
    host: '127.0.0.1',
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: jwks.url,
    clockSkewSeconds: 30,
    dbPath: ':memory:',
  }
  app = await buildApp({ config: { ...baseConfig, dataDir }, logger: false })
  cappedApp = await buildApp({
    config: { ...baseConfig, dataDir: cappedDataDir },
    logger: false,
    maxDocumentBytes: SMALL_CAP,
  })
  const sign = (sub: string): Promise<string> =>
    signAccessToken(key.privateKey, key.kid, { iss: ISSUER, aud: AUDIENCE, sub })
  tokenA = await sign('user-a')
  tokenB = await sign('user-b')
  tokenHostile = await sign('../escape/attempt')
})

afterAll(async () => {
  await app.close()
  await cappedApp.close()
  await jwks.stop()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(cappedDataDir, { recursive: true, force: true })
})

// ── Helpers ────────────────────────────────────────────────────────────

interface Options {
  token?: string | null
  headers?: Record<string, string>
  payload?: Buffer | string
  ifMatch?: string
}

/** Injected response: status/body plus `rawPayload` (byte-exact downloads). */
interface RawResponse {
  statusCode: number
  body: string
  rawPayload: Buffer
  headers: Record<string, string>
  json: () => any
}

/** Raw inject (downloads need bytes, not JSON). Default user: A. */
async function req(method: string, url: string, opts: Options = {}): Promise<RawResponse> {
  const token = opts.token === undefined ? tokenA : opts.token
  const headers: Record<string, string> = {
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...opts.headers,
    ...(opts.ifMatch === undefined ? {} : { 'if-match': opts.ifMatch }),
  }
  return (await app.inject({
    method: method as any,
    url,
    headers,
    ...(opts.payload === undefined ? {} : { payload: opts.payload }),
  })) as unknown as RawResponse
}

async function json(
  method: string,
  url: string,
  opts: Options = {},
): Promise<{ status: number; body: any }> {
  const res = await req(method, url, opts)
  return { status: res.statusCode, body: res.body === '' ? undefined : res.json() }
}

/** Builds a multipart/form-data body with the given fields and one file part. */
function multipart(
  fields: Record<string, string>,
  file: Buffer,
  extraFile?: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----genoffice${randomUUID()}`
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }
  const filePart = (filename: string): Buffer =>
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
    )
  chunks.push(filePart('upload.bin'), file)
  if (extraFile !== undefined) chunks.push(Buffer.from('\r\n'), filePart('second.bin'), extraFile)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** Uploads a document as a user (multipart primary path) and returns its record. */
async function createDocument(
  name: string,
  kind: string,
  bytes: Buffer,
  token: string = tokenA,
): Promise<any> {
  const res = await req('POST', '/documents', {
    token,
    ...multipart({ name, kind }, bytes),
  })
  expect(res.statusCode).toBe(201)
  return res.json()
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ── CRUD + version chain ───────────────────────────────────────────────

describe('documents CRUD', () => {
  it('creates version 1 from a multipart upload (201, record with size + sha256)', async () => {
    const bytes = Buffer.from('# Hello\n\nworld')
    const doc = await createDocument('notes.md', 'md', bytes)
    expect(doc).toEqual({
      id: expect.stringMatching(UUID_RE) as string,
      name: 'notes.md',
      kind: 'md',
      size: bytes.length,
      sha256: sha256(bytes),
      currentVersion: 1,
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    })
  })

  it('downloads the current bytes exactly, with etag/version and disposition headers', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02])
    const doc = await createDocument('sheet.xlsx', 'xlsx', bytes)
    const res = await req('GET', `/documents/${doc.id}`)
    expect(res.statusCode).toBe(200)
    expect(Buffer.from(res.rawPayload).equals(bytes)).toBe(true)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers.etag).toBe('1')
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="sheet.xlsx"; filename*=UTF-8\'\'sheet.xlsx',
    )
  })

  it('creates from a raw octet-stream body with query params and round-trips the bytes', async () => {
    const bytes = Buffer.from('%PDF-1.7 raw body path')
    const res = await req('POST', '/documents?name=raw%20doc.pdf&kind=pdf', {
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    })
    expect(res.statusCode).toBe(201)
    const doc = res.json()
    expect(doc).toMatchObject({
      name: 'raw doc.pdf',
      kind: 'pdf',
      size: bytes.length,
      currentVersion: 1,
    })
    const got = await req('GET', `/documents/${doc.id}`)
    expect(Buffer.from(got.rawPayload).equals(bytes)).toBe(true)
  })

  it('lists metadata only (name, kind, size, updatedAt, currentVersion) in a stable order', async () => {
    const first = await createDocument('list-a.md', 'md', Buffer.from('a'))
    await createDocument('list-b.html', 'html', Buffer.from('b'))
    const res = await json('GET', '/documents')
    expect(res.status).toBe(200)
    const items: any[] = res.body.documents
    expect(items.length).toBeGreaterThanOrEqual(2)
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'currentVersion',
        'id',
        'kind',
        'name',
        'size',
        'updatedAt',
      ])
    }
    const ids = items.map((d) => d.id)
    expect(ids).toContain(first.id)
    expect(items).toEqual(
      [...items].sort((a, b) => `${a.createdAt}${a.id}`.localeCompare(`${b.createdAt}${b.id}`)),
    )
  })

  it('PUT appends a version: fresh If-Match wins, old bytes stay downloadable', async () => {
    const v1 = Buffer.from('version one')
    const v2 = Buffer.from('version two — longer')
    const doc = await createDocument('history.md', 'md', v1)
    const put = await req('PUT', `/documents/${doc.id}`, { ...multipart({}, v2), ifMatch: '1' })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({
      id: doc.id,
      name: 'history.md',
      size: v2.length,
      sha256: sha256(v2),
      currentVersion: 2,
    })

    const current = await req('GET', `/documents/${doc.id}`)
    expect(Buffer.from(current.rawPayload).equals(v2)).toBe(true)
    expect(current.headers.etag).toBe('2')

    const old = await req('GET', `/documents/${doc.id}/versions/1`)
    expect(old.statusCode).toBe(200)
    expect(Buffer.from(old.rawPayload).equals(v1)).toBe(true)
    expect(old.headers.etag).toBe('1')

    const versions = await json('GET', `/documents/${doc.id}/versions`)
    expect(versions.status).toBe(200)
    expect(versions.body.versions).toEqual([
      { version: 2, size: v2.length, sha256: sha256(v2), createdAt: expect.any(String) as string },
      { version: 1, size: v1.length, sha256: sha256(v1), createdAt: expect.any(String) as string },
    ])
  })

  it('PUT with a raw body and no If-Match is last-writer-wins; optional name/kind update', async () => {
    const doc = await createDocument('rename-me.md', 'md', Buffer.from('one'))
    const put = await req('PUT', `/documents/${doc.id}?name=renamed.html&kind=html`, {
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('two'),
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ name: 'renamed.html', kind: 'html', currentVersion: 2 })
    const got = await json('GET', '/documents')
    const mine = (got.body.documents as any[]).find((d) => d.id === doc.id)
    expect(mine).toMatchObject({ name: 'renamed.html', kind: 'html', currentVersion: 2 })
  })

  it('answers 404 (not_found) for GET/PUT/DELETE of a missing document', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    for (const [method, url, opts] of [
      ['GET', `/documents/${missing}`, {}],
      ['PUT', `/documents/${missing}`, multipart({ name: 'x', kind: 'md' }, Buffer.from('x'))],
      ['DELETE', `/documents/${missing}`, {}],
      ['GET', `/documents/${missing}/versions`, {}],
      ['GET', `/documents/${missing}/versions/1`, {}],
    ] as const) {
      const res = await req(method, url, opts)
      expect(res.statusCode, `${method} ${url}`).toBe(404)
      expect(res.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) as string },
      })
    }
  })

  it('hard-deletes rows and files (204, then 404 everywhere, directory gone)', async () => {
    const doc = await createDocument('doomed.md', 'md', Buffer.from('bye'))
    const dir = join(dataDir, 'user-a', doc.id)
    expect(existsSync(join(dir, '1'))).toBe(true)
    const del = await req('DELETE', `/documents/${doc.id}`, { ifMatch: '1' })
    expect(del.statusCode).toBe(204)
    expect(del.body).toBe('')
    expect((await json('GET', `/documents/${doc.id}`)).status).toBe(404)
    expect((await json('GET', `/documents/${doc.id}/versions`)).status).toBe(404)
    const listed = await json('GET', '/documents')
    expect((listed.body.documents as any[]).some((d) => d.id === doc.id)).toBe(false)
    expect(existsSync(dir)).toBe(false)
  })
})

// ── If-Match guard ─────────────────────────────────────────────────────

describe('If-Match version guard (documents)', () => {
  it('rejects a stale PUT with 409 version_conflict and keeps the stored bytes', async () => {
    const doc = await createDocument('guarded.md', 'md', Buffer.from('first'))
    await req('PUT', `/documents/${doc.id}`, multipart({}, Buffer.from('second')))
    const stale = await req('PUT', `/documents/${doc.id}`, {
      ...multipart({}, Buffer.from('third')),
      ifMatch: '1',
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({
      error: { code: 'version_conflict', message: expect.any(String) as string },
    })
    const current = await req('GET', `/documents/${doc.id}`)
    expect(Buffer.from(current.rawPayload).toString()).toBe('second')
    const versions = await json('GET', `/documents/${doc.id}/versions`)
    expect((versions.body.versions as any[]).map((v) => v.version)).toEqual([2, 1])
  })

  it('rejects a stale DELETE with 409 and deletes on a match', async () => {
    const doc = await createDocument('delete-guarded.md', 'md', Buffer.from('x'))
    await req('PUT', `/documents/${doc.id}`, multipart({}, Buffer.from('y')))
    const stale = await req('DELETE', `/documents/${doc.id}`, { ifMatch: '1' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('version_conflict')
    expect((await req('GET', `/documents/${doc.id}`)).statusCode).toBe(200)
    const ok = await req('DELETE', `/documents/${doc.id}`, { ifMatch: '2' })
    expect(ok.statusCode).toBe(204)
    expect((await req('GET', `/documents/${doc.id}`)).statusCode).toBe(404)
  })

  it('rejects a non-integer If-Match with 400 validation_failed', async () => {
    const doc = await createDocument('bad-if-match.md', 'md', Buffer.from('x'))
    for (const bad of ['"1"', '*', '1, 2', '-1', 'v1']) {
      const res = await req('PUT', `/documents/${doc.id}`, {
        ...multipart({}, Buffer.from('y')),
        ifMatch: bad,
      })
      expect(res.statusCode, `If-Match=${JSON.stringify(bad)}`).toBe(400)
      expect(res.json().error.code).toBe('validation_failed')
    }
  })

  it('still answers 404 (not 409) for a missing id with any If-Match', async () => {
    const res = await req('DELETE', '/documents/00000000-0000-4000-8000-000000000000', {
      ifMatch: '99',
    })
    expect(res.statusCode).toBe(404)
  })
})

// ── Conflict copies ────────────────────────────────────────────────────

describe('conflict copies (?conflict=copy)', () => {
  it('stores a stale upload as a NEW document named "<name> (conflict <ISO>)"', async () => {
    const original = Buffer.from('server truth')
    const mine = Buffer.from('my conflicting edit')
    const doc = await createDocument('report.md', 'md', original)
    // Another device bumps the version; our edit is now stale.
    await req('PUT', `/documents/${doc.id}`, multipart({}, Buffer.from('v2 bytes')))
    const conflict = await req(
      'PUT',
      `/documents/${doc.id}?conflict=copy`,
      multipart({ name: 'report.md', kind: 'md' }, mine),
    )
    expect(conflict.statusCode).toBe(201)
    const copy = conflict.json()
    expect(copy.id).not.toBe(doc.id)
    expect(copy.name).toMatch(
      /^report\.md \(conflict \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)$/,
    )
    expect(copy).toMatchObject({
      kind: 'md',
      size: mine.length,
      sha256: sha256(mine),
      currentVersion: 1,
    })

    const copyBytes = await req('GET', `/documents/${copy.id}`)
    expect(Buffer.from(copyBytes.rawPayload).equals(mine)).toBe(true)
    // The original is untouched and still at version 2.
    const originalBytes = await req('GET', `/documents/${doc.id}`)
    expect(Buffer.from(originalBytes.rawPayload).toString()).toBe('v2 bytes')
    const versions = await json('GET', `/documents/${doc.id}/versions`)
    expect((versions.body.versions as any[]).map((v) => v.version)).toEqual([2, 1])
  })

  it('keeps the stored name/kind when the copy upload carries no metadata', async () => {
    const doc = await createDocument('keep-name.md', 'md', Buffer.from('a'))
    const conflict = await req(
      'PUT',
      `/documents/${doc.id}?conflict=copy`,
      multipart({}, Buffer.from('b')),
    )
    expect(conflict.statusCode).toBe(201)
    expect(conflict.json()).toMatchObject({
      name: expect.stringMatching(/^keep-name\.md \(conflict /) as string,
      kind: 'md',
    })
  })

  it('answers 404 for a conflict-copy against a missing document', async () => {
    const res = await req(
      'PUT',
      '/documents/00000000-0000-4000-8000-000000000000?conflict=copy',
      multipart({}, Buffer.from('x')),
    )
    expect(res.statusCode).toBe(404)
  })

  it('rejects any other conflict value with 400', async () => {
    const doc = await createDocument('conflict-value.md', 'md', Buffer.from('x'))
    const res = await req(
      'PUT',
      `/documents/${doc.id}?conflict=overwrite`,
      multipart({}, Buffer.from('y')),
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
  })
})

// ── Version retention (prune at 51) ────────────────────────────────────

describe('version retention (max 50)', () => {
  it('keeps the newest 50 versions and prunes the oldest rows and files', async () => {
    const doc = await createDocument('chain.md', 'md', Buffer.from('v1'))
    for (let v = 2; v <= 51; v++) {
      const res = await req('PUT', `/documents/${doc.id}`, multipart({}, Buffer.from(`v${v}`)))
      expect(res.statusCode, `version ${v}`).toBe(200)
      expect(res.json().currentVersion).toBe(v)
    }
    const listed = await json('GET', `/documents/${doc.id}/versions`)
    const versions = listed.body.versions as any[]
    expect(versions).toHaveLength(50)
    expect(versions[0]).toMatchObject({ version: 51 })
    expect(versions[49]).toMatchObject({ version: 2 })
    expect(versions.map((v) => v.version)).not.toContain(1)

    // Pruned version: row gone (404) AND file gone.
    expect((await json('GET', `/documents/${doc.id}/versions/1`)).status).toBe(404)
    const dir = join(dataDir, 'user-a', doc.id)
    expect(existsSync(join(dir, '1'))).toBe(false)
    expect(existsSync(join(dir, '2'))).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(
      Array.from({ length: 50 }, (_, i) => String(i + 2)).sort(),
    )
    // The retained versions still round-trip their exact bytes.
    const v2 = await req('GET', `/documents/${doc.id}/versions/2`)
    expect(Buffer.from(v2.rawPayload).toString()).toBe('v2')
    const current = await req('GET', `/documents/${doc.id}`)
    expect(Buffer.from(current.rawPayload).toString()).toBe('v51')
    expect(current.headers.etag).toBe('51')
  })
})

// ── Upload limits (413) and media types ────────────────────────────────

describe('upload limits and media types (capped app)', () => {
  it('rejects a multipart upload one byte over the cap with 413 payload_too_large', async () => {
    const over = Buffer.alloc(SMALL_CAP + 1, 0x61)
    const body = multipart({ name: 'big.md', kind: 'md' }, over)
    const res = await cappedApp.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenA}`, ...body.headers },
      payload: body.payload,
    })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({
      error: { code: 'payload_too_large', message: expect.any(String) as string },
    })
    const listed = await cappedApp.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenA}` },
    })
    expect(listed.json().documents).toEqual([])
    // Nothing was staged: no document directory under the user's tree.
    expect(readdirSync(join(cappedDataDir, 'user-a'))).toEqual([])
  })

  it('rejects a raw upload over the cap the same way', async () => {
    const res = await cappedApp.inject({
      method: 'POST',
      url: '/documents?name=raw.md&kind=md',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(SMALL_CAP + 1, 0x62),
    })
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe('payload_too_large')
  })

  it('accepts an upload exactly at the cap', async () => {
    const at = Buffer.alloc(SMALL_CAP, 0x63)
    const body = multipart({ name: 'edge.md', kind: 'md' }, at)
    const res = await cappedApp.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenA}`, ...body.headers },
      payload: body.payload,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ size: SMALL_CAP, currentVersion: 1 })
  })

  it('rejects an unsupported content type with 415 unsupported_media_type', async () => {
    const res = await req('POST', '/documents', {
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x', kind: 'md' }),
    })
    expect(res.statusCode).toBe(415)
    expect(res.json().error.code).toBe('unsupported_media_type')
  })
})

// ── Validation (400) ───────────────────────────────────────────────────

describe('upload validation (400)', () => {
  const cases: Array<[string, Record<string, string> | undefined, string]> = [
    ['missing name', { kind: 'md' }, '/documents'],
    ['missing kind', { name: 'x.md' }, '/documents'],
    ['blank name', { name: '   ', kind: 'md' }, '/documents'],
    ['unknown kind', { name: 'x.txt', kind: 'txt' }, '/documents'],
    ['oversized name', { name: `${'x'.repeat(256)}.md`, kind: 'md' }, '/documents'],
    ['unknown field', { name: 'x.md', kind: 'md', extra: 'nope' }, '/documents'],
  ]
  for (const [what, fields, url] of cases) {
    it(`rejects a multipart create with ${what}`, async () => {
      const res = await req('POST', url, multipart(fields ?? {}, Buffer.from('x')))
      expect(res.statusCode, what).toBe(400)
      expect(res.json().error.code).toBe('validation_failed')
    })
  }

  it('rejects a duplicate form field', async () => {
    const boundary = '----genofficedup'
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="name"\r\n\r\nfirst\r\n` +
          `--${boundary}\r\ncontent-disposition: form-data; name="name"\r\n\r\nsecond\r\n` +
          `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\nmd\r\n` +
          `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="f"\r\n\r\n`,
      ),
      Buffer.from('x'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await req('POST', '/documents', {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('rejects a second file part', async () => {
    const res = await req(
      'POST',
      '/documents',
      multipart({ name: 'two.md', kind: 'md' }, Buffer.from('one'), Buffer.from('two')),
    )
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('rejects a multipart body without a file part', async () => {
    const boundary = '----genoffice-nofile'
    const payload = Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="name"\r\n\r\nx.md\r\n` +
        `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\nmd\r\n` +
        `--${boundary}--\r\n`,
    )
    const res = await req('POST', '/documents', {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects metadata sent as query params on a multipart upload', async () => {
    const res = await req('POST', '/documents?name=q.md&kind=md', multipart({}, Buffer.from('x')))
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('validation_failed')
  })

  it('rejects a bad version path segment and unknown query params', async () => {
    const doc = await createDocument('params.md', 'md', Buffer.from('x'))
    expect((await json('GET', `/documents/${doc.id}/versions/0`)).status).toBe(400)
    expect((await json('GET', `/documents/${doc.id}/versions/abc`)).status).toBe(400)
    expect((await json('GET', `/documents/${doc.id}/versions/99999999999999999999`)).status).toBe(
      400,
    )
    expect(
      (
        await json('POST', '/documents?name=x.md&kind=md&extra=1', {
          headers: { 'content-type': 'application/octet-stream' },
        })
      ).status,
    ).toBe(400)
  })
})

// ── Integrity on read ──────────────────────────────────────────────────

describe('integrity check on read', () => {
  it('answers a clean 500 (no path leak) when stored bytes no longer match their sha256', async () => {
    const doc = await createDocument('corrupt-me.md', 'md', Buffer.from('original bytes'))
    const file = join(dataDir, 'user-a', doc.id, '1')
    writeFileSync(file, Buffer.from('tampered bytes'))
    const res = await req('GET', `/documents/${doc.id}`)
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({
      error: { code: 'internal_error', message: expect.any(String) as string },
    })
    expect(res.body).not.toContain(dataDir)
    expect(res.body).not.toContain(doc.id)
  })
})

// ── Concurrency (per-document lock) ────────────────────────────────────

describe('concurrent writes', () => {
  it('serializes concurrent PUTs: no lost updates, contiguous versions, intact bytes', async () => {
    const doc = await createDocument('race.md', 'md', Buffer.from('body-v1'))
    const results = await Promise.all(
      ['v2', 'v3', 'v4'].map((text) =>
        req('PUT', `/documents/${doc.id}`, multipart({}, Buffer.from(`body-${text}`))),
      ),
    )
    for (const res of results) expect(res.statusCode).toBe(200)

    // The lock makes each PUT an atomic read-stage-commit; which of the
    // concurrent bodies lands on which version number is scheduling, so the
    // invariants are: exactly versions 1..4, each downloading its own intact
    // bytes (the download's sha256 check would 500 on any clobbering).
    const listed = await json('GET', `/documents/${doc.id}/versions`)
    expect((listed.body.versions as any[]).map((v) => v.version)).toEqual([4, 3, 2, 1])
    const seen = new Set<string>()
    for (let v = 1; v <= 4; v++) {
      const got = await req('GET', `/documents/${doc.id}/versions/${v}`)
      expect(got.statusCode, `version ${v}`).toBe(200)
      seen.add(Buffer.from(got.rawPayload).toString())
    }
    expect(seen).toEqual(new Set(['body-v1', 'body-v2', 'body-v3', 'body-v4']))
  })
})

// ── Cross-user isolation (metadata AND bytes) ──────────────────────────

describe('cross-user isolation (user B vs user A)', () => {
  let aDoc: any
  const aBytes = Buffer.from('a secret document body')

  beforeAll(async () => {
    aDoc = await createDocument('a-only.md', 'md', aBytes)
  })

  it("does not include A's document in B's list", async () => {
    const res = await json('GET', '/documents', { token: tokenB })
    expect(res.status).toBe(200)
    expect((res.body.documents as any[]).map((d) => d.id)).not.toContain(aDoc.id)
  })

  it("B cannot download, update, delete, or read history of A's document — 404 identical to missing", async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    const probes: Array<[string, string, Options]> = [
      ['GET', `/documents/${aDoc.id}`, {}],
      ['PUT', `/documents/${aDoc.id}`, multipart({}, Buffer.from('hijack'))],
      ['DELETE', `/documents/${aDoc.id}`, {}],
      ['GET', `/documents/${aDoc.id}/versions`, {}],
      ['GET', `/documents/${aDoc.id}/versions/1`, {}],
    ]
    for (const [method, url, opts] of probes) {
      const foreign = await req(method, url, { ...opts, token: tokenB })
      const absent = await req(method, url.replace(aDoc.id, missing), { ...opts, token: tokenB })
      expect(foreign.statusCode, `${method} ${url}`).toBe(404)
      expect(foreign.statusCode).toBe(absent.statusCode)
      expect(foreign.body).toBe(absent.body)
    }
    const stillA = await req('GET', `/documents/${aDoc.id}`)
    expect(Buffer.from(stillA.rawPayload).equals(aBytes)).toBe(true)
  })

  it('gives each user an independent byte tree on disk', async () => {
    const bDoc = await createDocument('b-own.md', 'md', Buffer.from('b bytes'), tokenB)
    expect(existsSync(join(dataDir, 'user-a', aDoc.id, '1'))).toBe(true)
    expect(existsSync(join(dataDir, 'user-b', bDoc.id, '1'))).toBe(true)
    expect(readdirSync(join(dataDir, 'user-b')).sort()).toEqual([bDoc.id].sort())
    const aDir = readdirSync(join(dataDir, 'user-a'))
    expect(aDir).not.toContain(bDoc.id)
    expect(aDir).toContain(aDoc.id)
  })

  it('keeps a hostile sub inside one encoded directory (no path escape)', async () => {
    const doc = await createDocument('hostile.md', 'md', Buffer.from('h'), tokenHostile)
    const encoded = encodeURIComponent('../escape/attempt')
    expect(existsSync(join(dataDir, encoded, doc.id, '1'))).toBe(true)
    expect(existsSync(join(dataDir, '..', 'escape'))).toBe(false)
    const got = await req('GET', `/documents/${doc.id}`, { token: tokenHostile })
    expect(Buffer.from(got.rawPayload).toString()).toBe('h')
    // And the hostile sub cannot reach A's document either.
    expect((await json('GET', `/documents/${aDoc.id}`, { token: tokenHostile })).status).toBe(404)
  })
})

// ── Auth ───────────────────────────────────────────────────────────────

describe('auth (401)', () => {
  it('requires a bearer token on every document route', async () => {
    const doc = await createDocument('auth.md', 'md', Buffer.from('x'))
    const cases: Array<[string, string, Options]> = [
      ['GET', '/documents', {}],
      ['POST', '/documents', multipart({ name: 'x.md', kind: 'md' }, Buffer.from('x'))],
      ['GET', `/documents/${doc.id}`, {}],
      ['PUT', `/documents/${doc.id}`, multipart({}, Buffer.from('y'))],
      ['DELETE', `/documents/${doc.id}`, {}],
      ['GET', `/documents/${doc.id}/versions`, {}],
      ['GET', `/documents/${doc.id}/versions/1`, {}],
    ]
    for (const [method, url, opts] of cases) {
      const res = await req(method, url, { ...opts, token: null })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
      expect(res.json().error.code).toBe('missing_token')
    }
  })
})
