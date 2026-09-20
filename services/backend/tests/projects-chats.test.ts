/**
 * Unit suite for the projects/chats CRUD endpoints (Phase 6a).
 *
 * Same harness conventions as verify-auth.test.ts: real RS256 tokens minted
 * locally, a real HTTP JWKS server, and the real `verifyAuth` plugin — plus
 * the real SQLite store on an in-memory database. Two users (`user-a`,
 * `user-b`) exercise the structural `sub` scoping: user B must never see or
 * mutate user A's data, and foreign resources must answer 404 exactly like
 * missing ones (no existence leak).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { generateTestKey, JwksTestServer, type TestKey } from './helpers/jwks-server.js'
import { signAccessToken } from './helpers/tokens.js'

const ISSUER = 'https://auth.test/realms/genoffice'
const AUDIENCE = 'genoffice-backend'

let jwks: JwksTestServer
let key: TestKey
let app: FastifyInstance
let tokenA: string
let tokenB: string

beforeAll(async () => {
  jwks = await JwksTestServer.start()
  key = await generateTestKey('kid-a')
  jwks.setKeys([key])
  app = await buildApp({
    config: {
      port: 0,
      host: '127.0.0.1',
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: jwks.url,
      clockSkewSeconds: 30,
      dbPath: ':memory:',
    },
    logger: false,
  })
  tokenA = await signAccessToken(key.privateKey, key.kid, {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-a',
  })
  tokenB = await signAccessToken(key.privateKey, key.kid, {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-b',
  })
})

afterAll(async () => {
  await app.close()
  await jwks.stop()
})

interface InjectOptions {
  method: string
  url: string
  /** Bearer token; defaults to user A, `null` sends no credentials. */
  token?: string | null
  body?: unknown
}

/** Inject a request as the given user (default: user A; `null` = anonymous). */
async function call(opts: InjectOptions): Promise<{ status: number; json: any; body: string }> {
  const token = opts.token === undefined ? tokenA : opts.token
  const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const res = await app.inject({
    method: opts.method as any,
    url: opts.url,
    headers,
    ...(opts.body === undefined ? {} : { payload: JSON.stringify(opts.body) }),
  })
  let json: any = undefined
  try {
    json = res.json()
  } catch {
    // 204s have no body
  }
  return { status: res.statusCode, json, body: res.body }
}

/** Create a project as a user and return its id. */
async function createProject(name: string, token: string = tokenA): Promise<string> {
  const res = await call({ method: 'POST', url: '/projects', token, body: { name } })
  expect(res.status).toBe(201)
  return res.json.id as string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('projects CRUD', () => {
  it('creates a project (201, server-assigned UUID, version 1, empty files)', async () => {
    const res = await call({ method: 'POST', url: '/projects', body: { name: 'Projekt Alpha' } })
    expect(res.status).toBe(201)
    expect(res.json).toEqual({
      id: expect.stringMatching(UUID_RE) as string,
      name: 'Projekt Alpha',
      files: [],
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
      version: 1,
    })
  })

  it('trims the name on create', async () => {
    const res = await call({ method: 'POST', url: '/projects', body: { name: '  padded  ' } })
    expect(res.status).toBe(201)
    expect(res.json.name).toBe('padded')
  })

  it('gets a project with its files (full shape)', async () => {
    const id = await createProject('Get Me')
    const res = await call({ method: 'GET', url: `/projects/${id}` })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      id,
      name: 'Get Me',
      files: [],
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
      version: 1,
    })
  })

  it('lists projects as info records (no files) in a stable order', async () => {
    const first = await createProject('List First')
    await createProject('List Second')
    const res = await call({ method: 'GET', url: '/projects' })
    expect(res.status).toBe(200)
    const items: any[] = res.json.projects
    expect(items.length).toBeGreaterThanOrEqual(2)
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'id', 'name', 'updatedAt', 'version'])
    }
    const ids = items.map((p) => p.id)
    expect(ids).toContain(first)
    // Stable order: (createdAt, id) ascending. Rapid same-millisecond
    // creations tie on createdAt and fall back to the id tiebreaker, so only
    // the ORDER's stability is asserted, not strict creation sequence.
    expect(items).toEqual(
      [...items].sort((a, b) => `${a.createdAt}${a.id}`.localeCompare(`${b.createdAt}${b.id}`)),
    )
  })

  it('updates a project (full replace) and bumps version + updatedAt', async () => {
    const id = await createProject('Before')
    const res = await call({
      method: 'PUT',
      url: `/projects/${id}`,
      body: { name: 'After', files: ['/tmp/one.md', '/tmp/two.docx'] },
    })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      id,
      name: 'After',
      files: ['/tmp/one.md', '/tmp/two.docx'],
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
      version: 2,
    })
    const got = await call({ method: 'GET', url: `/projects/${id}` })
    expect(got.json.name).toBe('After')
    expect(got.json.files).toEqual(['/tmp/one.md', '/tmp/two.docx'])
    expect(got.json.version).toBe(2)
  })

  it('answers 404 (not_found) for updating a missing project', async () => {
    const res = await call({
      method: 'PUT',
      url: '/projects/00000000-0000-4000-8000-000000000000',
      body: { name: 'Ghost', files: [] },
    })
    expect(res.status).toBe(404)
    expect(res.json).toEqual({
      error: { code: 'not_found', message: expect.any(String) as string },
    })
  })

  it('hard-deletes a project (204) and it is gone afterwards', async () => {
    const id = await createProject('Doomed')
    const del = await call({ method: 'DELETE', url: `/projects/${id}` })
    expect(del.status).toBe(204)
    expect(del.body).toBe('')
    const got = await call({ method: 'GET', url: `/projects/${id}` })
    expect(got.status).toBe(404)
  })

  it('answers 404 for deleting a missing project', async () => {
    const res = await call({ method: 'DELETE', url: '/projects/not-a-real-id' })
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('not_found')
  })
})

describe('chats CRUD (nested under a project)', () => {
  it('creates an empty chat (201, version 1) under an owned project', async () => {
    const projectId = await createProject('Chat Host')
    const res = await call({ method: 'POST', url: `/projects/${projectId}/chats` })
    expect(res.status).toBe(201)
    expect(res.json).toEqual({
      id: expect.stringMatching(UUID_RE) as string,
      projectId,
      messages: [],
      messageCount: 0,
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
      version: 1,
    })
  })

  it('answers 404 for creating a chat under a missing project', async () => {
    const res = await call({ method: 'POST', url: '/projects/does-not-exist/chats' })
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('not_found')
  })

  it('replaces messages (PUT): server assigns seq, defaults ts, bumps version', async () => {
    const projectId = await createProject('Msg Host')
    const chat = await call({ method: 'POST', url: `/projects/${projectId}/chats` })
    const chatId = chat.json.id

    const put = await call({
      method: 'PUT',
      url: `/projects/${projectId}/chats/${chatId}`,
      body: {
        messages: [
          { role: 'user', text: 'hello' },
          { role: 'assistant', text: 'hi there', ts: '2026-01-02T03:04:05.000Z' },
        ],
      },
    })
    expect(put.status).toBe(200)
    expect(put.json.version).toBe(2)
    expect(put.json.messages).toEqual([
      { seq: 1, ts: expect.any(String) as string, role: 'user', text: 'hello' },
      {
        seq: 2,
        ts: '2026-01-02T03:04:05.000Z',
        role: 'assistant',
        text: 'hi there',
      },
    ])

    const got = await call({ method: 'GET', url: `/projects/${projectId}/chats/${chatId}` })
    expect(got.status).toBe(200)
    expect(got.json.messages).toHaveLength(2)
    expect(got.json.version).toBe(2)
  })

  it('round-trips optional message fields (fileRef, tools, attachments, scope)', async () => {
    const projectId = await createProject('Fields Host')
    const chat = await call({ method: 'POST', url: `/projects/${projectId}/chats` })
    const chatId = chat.json.id
    const message = {
      role: 'assistant',
      text: 'with extras',
      fileRef: '/tmp/report.docx',
      tools: [{ name: 'search', summary: 'found 3 hits', isError: false }],
      attachments: [{ name: 'data.csv', ext: 'csv', sizeBytes: 12 }],
      scope: { label: 'Intro paragraph', text: '…selected text…' },
    }
    const put = await call({
      method: 'PUT',
      url: `/projects/${projectId}/chats/${chatId}`,
      body: { messages: [message] },
    })
    expect(put.status).toBe(200)
    expect(put.json.messages[0]).toMatchObject({
      seq: 1,
      role: 'assistant',
      text: 'with extras',
      fileRef: '/tmp/report.docx',
      tools: [{ name: 'search', summary: 'found 3 hits', isError: false }],
      attachments: [{ name: 'data.csv', ext: 'csv', sizeBytes: 12 }],
      scope: { label: 'Intro paragraph', text: '…selected text…' },
    })
    // no undefined-valued keys serialized
    expect(JSON.stringify(put.json.messages[0])).not.toContain('undefined')
  })

  it('bumps version on every PUT (monotonic)', async () => {
    const projectId = await createProject('Version Host')
    const chatId = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    for (let i = 1; i <= 3; i++) {
      const res = await call({
        method: 'PUT',
        url: `/projects/${projectId}/chats/${chatId}`,
        body: { messages: [{ role: 'user', text: `round ${i}` }] },
      })
      expect(res.json.version).toBe(i + 1)
    }
  })

  it('honors ?limit=N with the most recent N messages in ascending seq order', async () => {
    const projectId = await createProject('Limit Host')
    const chatId = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    await call({
      method: 'PUT',
      url: `/projects/${projectId}/chats/${chatId}`,
      body: {
        messages: [1, 2, 3, 4, 5].map((n) => ({ role: 'user' as const, text: `m${n}` })),
      },
    })
    const res = await call({
      method: 'GET',
      url: `/projects/${projectId}/chats/${chatId}?limit=2`,
    })
    expect(res.status).toBe(200)
    expect(res.json.messages.map((m: any) => m.text)).toEqual(['m4', 'm5'])
  })

  it('lists chats with message counts', async () => {
    const projectId = await createProject('Chat List Host')
    const empty = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    const full = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    await call({
      method: 'PUT',
      url: `/projects/${projectId}/chats/${full}`,
      body: {
        messages: [
          { role: 'user', text: 'x' },
          { role: 'assistant', text: 'y' },
        ],
      },
    })
    const res = await call({ method: 'GET', url: `/projects/${projectId}/chats` })
    expect(res.status).toBe(200)
    const byId = new Map<string, any>((res.json.chats as any[]).map((c) => [c.id, c]))
    expect(byId.get(empty)).toMatchObject({ messageCount: 0, version: 1 })
    expect(byId.get(full)).toMatchObject({ messageCount: 2, version: 2 })
    for (const chat of res.json.chats) {
      expect(Object.keys(chat).sort()).toEqual([
        'createdAt',
        'id',
        'messageCount',
        'updatedAt',
        'version',
      ])
    }
  })

  it('answers 404 for a chat looked up under the wrong project (same owner)', async () => {
    const project1 = await createProject('Host One')
    const project2 = await createProject('Host Two')
    const chatId = (await call({ method: 'POST', url: `/projects/${project1}/chats` })).json.id
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const res = await call({
        method,
        url: `/projects/${project2}/chats/${chatId}`,
        ...(method === 'PUT' ? { body: { messages: [] } } : {}),
      })
      expect(res.status).toBe(404)
      expect(res.json.error.code).toBe('not_found')
    }
  })

  it('hard-deletes a chat (204) and it is gone afterwards', async () => {
    const projectId = await createProject('Chat Delete Host')
    const chatId = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    const del = await call({ method: 'DELETE', url: `/projects/${projectId}/chats/${chatId}` })
    expect(del.status).toBe(204)
    const got = await call({ method: 'GET', url: `/projects/${projectId}/chats/${chatId}` })
    expect(got.status).toBe(404)
  })

  it('deleting a project hard-deletes its chats too (cascade)', async () => {
    const projectId = await createProject('Cascade Host')
    const chatId = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    await call({
      method: 'PUT',
      url: `/projects/${projectId}/chats/${chatId}`,
      body: { messages: [{ role: 'user', text: 'doomed' }] },
    })
    const del = await call({ method: 'DELETE', url: `/projects/${projectId}` })
    expect(del.status).toBe(204)
    const chat = await call({ method: 'GET', url: `/projects/${projectId}/chats/${chatId}` })
    const list = await call({ method: 'GET', url: `/projects/${projectId}/chats` })
    expect(chat.status).toBe(404)
    expect(list.status).toBe(404)
  })
})

describe('cross-user isolation (user B vs user A)', () => {
  let aProject: string
  let aChat: string

  beforeAll(async () => {
    aProject = await createProject('A Only')
    aChat = (await call({ method: 'POST', url: `/projects/${aProject}/chats` })).json.id
    await call({
      method: 'PUT',
      url: `/projects/${aProject}/chats/${aChat}`,
      body: { messages: [{ role: 'user', text: 'secret' }] },
    })
  })

  it("does not include A's project in B's list", async () => {
    const res = await call({ method: 'GET', url: '/projects', token: tokenB })
    expect(res.status).toBe(200)
    expect((res.json.projects as any[]).map((p) => p.id)).not.toContain(aProject)
  })

  it("B cannot GET/PUT/DELETE A's project — 404 identical to a missing id", async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    const foreignGet = await call({ method: 'GET', url: `/projects/${aProject}`, token: tokenB })
    const missingGet = await call({ method: 'GET', url: `/projects/${missing}`, token: tokenB })
    expect(foreignGet.status).toBe(404)
    expect(foreignGet.status).toBe(missingGet.status)
    expect(foreignGet.json).toEqual(missingGet.json)

    const foreignPut = await call({
      method: 'PUT',
      url: `/projects/${aProject}`,
      token: tokenB,
      body: { name: 'hijacked', files: [] },
    })
    expect(foreignPut.status).toBe(404)
    const stillA = await call({ method: 'GET', url: `/projects/${aProject}` })
    expect(stillA.json.name).toBe('A Only')

    const foreignDelete = await call({
      method: 'DELETE',
      url: `/projects/${aProject}`,
      token: tokenB,
    })
    expect(foreignDelete.status).toBe(404)
    const stillThere = await call({ method: 'GET', url: `/projects/${aProject}` })
    expect(stillThere.status).toBe(200)
  })

  it("B cannot list/create chats under A's project — 404", async () => {
    const list = await call({ method: 'GET', url: `/projects/${aProject}/chats`, token: tokenB })
    expect(list.status).toBe(404)
    const create = await call({ method: 'POST', url: `/projects/${aProject}/chats`, token: tokenB })
    expect(create.status).toBe(404)
  })

  it("B cannot GET/PUT/DELETE A's chat — 404, data untouched", async () => {
    const foreignGet = await call({
      method: 'GET',
      url: `/projects/${aProject}/chats/${aChat}`,
      token: tokenB,
    })
    expect(foreignGet.status).toBe(404)

    const foreignPut = await call({
      method: 'PUT',
      url: `/projects/${aProject}/chats/${aChat}`,
      token: tokenB,
      body: { messages: [{ role: 'user', text: 'censored' }] },
    })
    expect(foreignPut.status).toBe(404)

    const foreignDelete = await call({
      method: 'DELETE',
      url: `/projects/${aProject}/chats/${aChat}`,
      token: tokenB,
    })
    expect(foreignDelete.status).toBe(404)

    const aView = await call({ method: 'GET', url: `/projects/${aProject}/chats/${aChat}` })
    expect(aView.status).toBe(200)
    expect(aView.json.messages[0].text).toBe('secret')
  })

  it('gives each user an independent namespace (B creates its own project)', async () => {
    const bId = await createProject('B Project', tokenB)
    const bListA = await call({ method: 'GET', url: '/projects' })
    expect((bListA.json.projects as any[]).map((p) => p.id)).not.toContain(bId)
    const bListB = await call({ method: 'GET', url: '/projects', token: tokenB })
    expect((bListB.json.projects as any[]).map((p) => p.id)).toContain(bId)
  })
})

describe('validation (400) and auth (401)', () => {
  it('requires a bearer token on every CRUD route', async () => {
    const projectId = await createProject('Auth Host')
    const chatId = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    const cases = [
      { method: 'GET', url: '/projects' },
      { method: 'POST', url: '/projects', body: { name: 'x' } },
      { method: 'GET', url: `/projects/${projectId}` },
      { method: 'PUT', url: `/projects/${projectId}`, body: { name: 'x', files: [] } },
      { method: 'DELETE', url: `/projects/${projectId}` },
      { method: 'GET', url: `/projects/${projectId}/chats` },
      { method: 'POST', url: `/projects/${projectId}/chats` },
      { method: 'GET', url: `/projects/${projectId}/chats/${chatId}` },
      {
        method: 'PUT',
        url: `/projects/${projectId}/chats/${chatId}`,
        body: { messages: [] },
      },
      { method: 'DELETE', url: `/projects/${projectId}/chats/${chatId}` },
    ]
    for (const c of cases) {
      const res = await call({ ...c, token: null })
      expect(res.status, `${c.method} ${c.url}`).toBe(401)
      expect(res.json.error.code).toBe('missing_token')
      expect(res.json.error).toEqual({ code: 'missing_token', message: expect.any(String) })
    }
  })

  it('rejects an invalid token with 401 invalid_token (envelope intact)', async () => {
    const res = await call({ method: 'GET', url: '/projects', token: 'not-a-jwt' })
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe('invalid_token')
  })

  it('rejects a missing/whitespace/oversized name with 400 validation_failed', async () => {
    for (const name of [undefined, '', '   ']) {
      const res = await call({ method: 'POST', url: '/projects', body: { name } })
      expect(res.status, `name=${JSON.stringify(name)}`).toBe(400)
      expect(res.json.error.code).toBe('validation_failed')
    }
  })

  it('rejects unknown body properties and wrong types (400)', async () => {
    const extra = await call({
      method: 'POST',
      url: '/projects',
      body: { name: 'x', id: 'client-chosen' },
    })
    expect(extra.status).toBe(400)
    expect(extra.json.error.code).toBe('validation_failed')

    const badFiles = await call({
      method: 'PUT',
      url: `/projects/${await createProject('VF')}`,
      body: { name: 'x', files: 'not-an-array' },
    })
    expect(badFiles.status).toBe(400)

    const missingFiles = await call({
      method: 'PUT',
      url: `/projects/${await createProject('VF2')}`,
      body: { name: 'x' },
    })
    expect(missingFiles.status).toBe(400)
  })

  it('rejects invalid message shapes with 400 (role, text, server-only seq, unknown field)', async () => {
    const projectId = await createProject('Msg Validation')
    const chatId = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    const url = `/projects/${projectId}/chats/${chatId}`
    const bad = [
      { messages: [{ role: 'system', text: 'x' }] },
      { messages: [{ role: 'user' }] },
      { messages: [{ role: 'user', text: 42 }] },
      { messages: [{ role: 'user', text: 'x', seq: 7 }] },
      { messages: [{ role: 'user', text: 'x', nope: true }] },
      { messages: 'nope' },
      {},
    ]
    for (const body of bad) {
      const res = await call({ method: 'PUT', url, body })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.json.error.code).toBe('validation_failed')
    }
  })

  it('rejects text beyond the store truncation limit (32 000 chars)', async () => {
    const projectId = await createProject('Msg Too Long')
    const chatId = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    const res = await call({
      method: 'PUT',
      url: `/projects/${projectId}/chats/${chatId}`,
      body: { messages: [{ role: 'user', text: 'x'.repeat(32_001) }] },
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-integer or non-positive limit query with 400', async () => {
    const projectId = await createProject('Limit Validation')
    const chatId = (await call({ method: 'POST', url: `/projects/${projectId}/chats` })).json.id
    for (const limit of ['zero', '0', '-3']) {
      const res = await call({
        method: 'GET',
        url: `/projects/${projectId}/chats/${chatId}?limit=${limit}`,
      })
      expect(res.status, `limit=${limit}`).toBe(400)
    }
  })
})

describe('uniform error envelope', () => {
  it('wraps unknown routes in {error:{code,message}}', async () => {
    const res = await call({ method: 'GET', url: '/nope' })
    expect(res.status).toBe(404)
    expect(res.json).toEqual({
      error: { code: 'not_found', message: expect.any(String) as string },
    })
  })

  it('wraps malformed JSON bodies in {error:{code,message}} with 400', async () => {
    const raw = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      payload: '{"name": broken',
    })
    expect(raw.statusCode).toBe(400)
    expect(raw.json()).toEqual({
      error: { code: 'bad_request', message: expect.any(String) as string },
    })
  })
})
