/**
 * Remote `ProjectApi` adapter tests against a scripted backend double.
 *
 * The double mirrors just enough of services/backend to exercise the
 * adapter's wire behavior: UUID ids, monotonic versions, `If-Match` 409s on
 * PUT/DELETE, server-assigned `seq`/`ts`, `?limit` reads, and the uniform
 * error envelope. Every test asserts the REST calls the adapter made (the
 * `calls` log) as well as the result, so the op → REST mapping is pinned.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/types.js'
import {
  RemoteProjectApi,
  RemoteProjectConflictError,
  RemoteProjectError,
  RemoteProjectUnavailableError,
  type RemoteProjectTransport,
} from '../src/remote.js'
import { ProjectStore, TEXT_MAX_CHARS, TOOL_FIELD_MAX_CHARS } from '../src/store.js'

// ────────────────────────────────────────────────────────────
// Backend double
// ────────────────────────────────────────────────────────────

interface Call {
  method: string
  path: string
  body?: unknown
  ifMatch?: string
}

interface FakeProject {
  id: string
  name: string
  files: string[]
  createdAt: string
  updatedAt: string
  version: number
}

interface FakeChat {
  id: string
  projectId: string
  createdAt: string
  updatedAt: string
  version: number
  messages: ChatMessage[]
}

let uuidCounter = 0
const uuid = (): string => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`

const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: { code: 'not_found', message: 'resource not found' } }), {
    status: 404,
  })

class FakeBackend {
  readonly projects = new Map<string, FakeProject>()
  readonly chats = new Map<string, FakeChat>()
  readonly calls: Call[] = []
  /** transport-level failure switch (offline / dead network) */
  offline = false
  /** every non-2xx status override, or a hook that runs just before a PUT */
  onPut: (() => void) | undefined

  readonly transport: RemoteProjectTransport = (path, init) => {
    if (this.offline) return Promise.reject(new TypeError('fetch failed'))
    const method = init?.method ?? 'GET'
    const rawBody = typeof init?.body === 'string' ? init.body : undefined
    const headers = new Headers(init?.headers)
    this.calls.push({
      method,
      path,
      body: rawBody === undefined ? undefined : (JSON.parse(rawBody) as unknown),
      ifMatch: headers.get('if-match') ?? undefined,
    })
    return Promise.resolve(this.route(method, path, rawBody, headers.get('if-match')))
  }

  private reply(status: number, body?: unknown): Response {
    return new Response(body === undefined ? undefined : JSON.stringify(body), { status })
  }

  private route(
    method: string,
    path: string,
    rawBody: string | undefined,
    ifMatch: string | null,
  ): Response {
    const body =
      rawBody === undefined ? undefined : (JSON.parse(rawBody) as Record<string, unknown>)
    const projectMatch = /^\/projects\/([^/]+)$/.exec(path)
    const chatMatch = /^\/projects\/([^/]+)\/chats\/([^/?]+)(\?limit=(\d+))?$/.exec(path)

    if (method === 'GET' && path === '/projects') {
      const projects = [...this.projects.values()].map(({ files: _files, ...info }) => info)
      return this.reply(200, { projects })
    }
    if (method === 'POST' && path === '/projects') {
      const now = new Date().toISOString()
      const project: FakeProject = {
        id: uuid(),
        name: String((body as { name: string }).name),
        files: [],
        createdAt: now,
        updatedAt: now,
        version: 1,
      }
      this.projects.set(project.id, project)
      return this.reply(201, project)
    }
    if (method === 'GET' && projectMatch) {
      const project = this.projects.get(projectMatch[1])
      return project === undefined ? NOT_FOUND() : this.reply(200, project)
    }
    if (method === 'POST' && /^\/projects\/([^/]+)\/chats$/.test(path)) {
      const projectId = /^\/projects\/([^/]+)\/chats$/.exec(path)![1]
      if (!this.projects.has(projectId)) return NOT_FOUND()
      const now = new Date().toISOString()
      const chat: FakeChat = {
        id: uuid(),
        projectId,
        createdAt: now,
        updatedAt: now,
        version: 1,
        messages: [],
      }
      this.chats.set(chat.id, chat)
      return this.reply(201, { ...chat, messageCount: 0 })
    }
    if (method === 'GET' && chatMatch) {
      const chat = this.chats.get(chatMatch[2])
      if (chat === undefined || chat.projectId !== chatMatch[1]) return NOT_FOUND()
      const limit = chatMatch[4] === undefined ? undefined : Number(chatMatch[4])
      const messages = limit === undefined ? chat.messages : chat.messages.slice(-limit)
      return this.reply(200, { ...chat, messageCount: chat.messages.length, messages })
    }
    if (method === 'PUT' && chatMatch) {
      this.onPut?.()
      const chat = this.chats.get(chatMatch[2])
      if (chat === undefined || chat.projectId !== chatMatch[1]) return NOT_FOUND()
      if (ifMatch !== null && Number(ifMatch) !== chat.version) {
        return this.reply(409, {
          error: { code: 'version_conflict', message: 'a newer version exists' },
        })
      }
      const now = new Date().toISOString()
      const input = (body as { messages: Array<Record<string, unknown>> }).messages
      // the real schema is additionalProperties:false — seq is server-only
      if (input.some((message) => 'seq' in message)) {
        return this.reply(400, {
          error: { code: 'validation_failed', message: 'seq is server-assigned' },
        })
      }
      chat.messages = input.map((message, index) => ({
        ...(message as Omit<ChatMessage, 'seq'> & { ts?: string }),
        seq: index + 1,
        ts: (message as { ts?: string }).ts ?? now,
      }))
      chat.version += 1
      chat.updatedAt = now
      return this.reply(200, { ...chat, messageCount: chat.messages.length })
    }
    if (method === 'DELETE' && chatMatch) {
      const chat = this.chats.get(chatMatch[2])
      if (chat === undefined || chat.projectId !== chatMatch[1]) return NOT_FOUND()
      if (ifMatch !== null && Number(ifMatch) !== chat.version) {
        return this.reply(409, {
          error: { code: 'version_conflict', message: 'a newer version exists' },
        })
      }
      this.chats.delete(chatMatch[2])
      return this.reply(204)
    }
    return NOT_FOUND()
  }

  /** The single chat row the tests created (there is at most one per test). */
  theChat(): FakeChat {
    const chat = [...this.chats.values()][0]
    if (chat === undefined) throw new Error('no chat row exists')
    return chat
  }

  /** The most recently created chat row (insertion order). */
  lastChat(): FakeChat {
    const chat = [...this.chats.values()].at(-1)
    if (chat === undefined) throw new Error('no chat row exists')
    return chat
  }
}

// ────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────

let dir: string
let backend: FakeBackend
let api: RemoteProjectApi
let indexPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remote-project-'))
  backend = new FakeBackend()
  indexPath = join(dir, 'remote-index.json')
  api = new RemoteProjectApi({ transport: backend.transport, indexPath })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const callsOf = (method: string): Call[] => backend.calls.filter((call) => call.method === method)

describe('resolveChat (pure — no requests)', () => {
  it('answers an unsaved file with the default project and the temp id', async () => {
    await expect(api.resolveChat({ filePath: null, tempChatId: 'unsaved-42' })).resolves.toEqual({
      projectId: 'default',
      chatId: 'unsaved-42',
    })
    expect(backend.calls).toEqual([])
  })

  it('derives a path chat id identical to the local store rule', async () => {
    const filePath = '/tmp/report.docx'
    const resolved = await api.resolveChat({ filePath })
    expect(resolved).toEqual({
      projectId: 'default',
      chatId: ProjectStore.chatIdForFile(filePath),
    })
    expect(backend.calls).toEqual([])
  })
})

describe('appendChat (read-modify-write with If-Match)', () => {
  it('lazily creates the default project and chat row on first append', async () => {
    const chatId = ProjectStore.chatIdForFile('/tmp/a.md')
    await api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'hello' })

    expect(callsOf('GET').map((c) => c.path)).toEqual([
      '/projects',
      `/projects/${backend.theChat().projectId}/chats/${backend.theChat().id}`,
    ])
    expect(callsOf('POST').map((c) => c.path)).toEqual([
      '/projects',
      `/projects/${backend.theChat().projectId}/chats`,
    ])
    const put = callsOf('PUT')
    expect(put).toHaveLength(1)
    expect(put[0].ifMatch).toBe('1')
    expect(put[0].body).toEqual({ messages: [{ role: 'user', text: 'hello' }] })
    expect(backend.theChat().messages).toEqual([
      expect.objectContaining({ seq: 1, role: 'user', text: 'hello' }),
    ])
    // the mapping survived to disk
    expect(JSON.parse(readFileSync(indexPath, 'utf8'))).toEqual({
      version: 1,
      defaultProjectId: backend.theChat().projectId,
      chats: { [chatId]: { projectId: backend.theChat().projectId, chatId: backend.theChat().id } },
    })
  })

  it('reuses an existing server-side default project by name', async () => {
    const existing = {
      id: uuid(),
      name: 'Default Project',
      files: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 7,
    }
    backend.projects.set(existing.id, existing)
    await api.appendChat({
      projectId: 'default',
      chatId: ProjectStore.chatIdForFile('/tmp/b.md'),
      role: 'user',
      text: 'hi',
    })
    expect(callsOf('POST').map((c) => c.path)).toEqual([`/projects/${existing.id}/chats`])
    expect(backend.theChat().projectId).toBe(existing.id)
  })

  it('accumulates messages across appends and re-guards each PUT', async () => {
    const chatId = ProjectStore.chatIdForFile('/tmp/c.md')
    await api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'one' })
    await api.appendChat({ projectId: 'default', chatId, role: 'assistant', text: 'two' })

    const puts = callsOf('PUT')
    expect(puts).toHaveLength(2)
    expect(puts[1].ifMatch).toBe('2') // the first PUT bumped the version
    expect(puts[1].body).toEqual({
      messages: [
        // the already-stored message keeps its server timestamp (and loses
        // its server seq); the fresh one carries neither
        { role: 'user', text: 'one', ts: backend.theChat().messages[0].ts },
        { role: 'assistant', text: 'two' },
      ],
    })
    expect(backend.theChat().version).toBe(3)
    expect(backend.theChat().messages.map((m) => m.text)).toEqual(['one', 'two'])
  })

  it('serializes concurrent appends so they never conflict with each other', async () => {
    const chatId = ProjectStore.chatIdForFile('/tmp/d.md')
    await Promise.all([
      api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'first' }),
      api.appendChat({ projectId: 'default', chatId, role: 'assistant', text: 'second' }),
    ])
    expect(
      backend
        .theChat()
        .messages.map((m) => m.text)
        .sort(),
    ).toEqual(['first', 'second'])
    expect(callsOf('PUT')).toHaveLength(2)
  })

  it('surfaces a 409 as a typed conflict, with no retry or overwrite', async () => {
    const chatId = ProjectStore.chatIdForFile('/tmp/e.md')
    await api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'kept' })

    // another device writes between this client's GET and PUT
    backend.onPut = () => {
      backend.theChat().version += 1
      backend.onPut = undefined
    }
    await expect(
      api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'lost' }),
    ).rejects.toBeInstanceOf(RemoteProjectConflictError)

    const puts = callsOf('PUT')
    expect(puts).toHaveLength(2) // the conflicted PUT is the last call: no re-read, no retry
    expect(backend.theChat().messages.map((m) => m.text)).toEqual(['kept'])
  })

  it('applies the local truncation constants before upload', async () => {
    const chatId = ProjectStore.chatIdForFile('/tmp/f.md')
    await api.appendChat({
      projectId: 'default',
      chatId,
      role: 'assistant',
      text: 'x'.repeat(TEXT_MAX_CHARS + 5_000),
      tools: [{ name: 'search', summary: 's', input: 'i'.repeat(TOOL_FIELD_MAX_CHARS + 5_000) }],
      scope: { label: 'selection', text: 'y'.repeat(500) },
    })
    const uploaded = (
      callsOf('PUT')[0].body as {
        messages: Array<{ text: string; tools?: Array<{ input: string }>; scope?: unknown }>
      }
    ).messages[0]
    expect(uploaded.text).toHaveLength(TEXT_MAX_CHARS)
    expect(uploaded.text.endsWith('\n\n[truncated]')).toBe(true)
    expect(uploaded.tools?.[0].input).toHaveLength(TOOL_FIELD_MAX_CHARS)
    expect(uploaded.scope).toEqual({ label: 'selection', text: 'y'.repeat(400) })
  })

  it('recovers when the mapped chat row vanished server-side', async () => {
    const chatId = ProjectStore.chatIdForFile('/tmp/g.md')
    await api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'before' })
    const deadChatId = backend.theChat().id
    backend.chats.delete(deadChatId)

    await api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'after' })
    expect(backend.theChat().id).not.toBe(deadChatId)
    expect(backend.theChat().messages.map((m) => m.text)).toEqual(['after'])
  })
})

describe('loadChat (tolerant reads)', () => {
  it('reads through ?limit=N after mapping the id', async () => {
    const chatId = ProjectStore.chatIdForFile('/tmp/h.md')
    await api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'one' })
    await api.appendChat({ projectId: 'default', chatId, role: 'assistant', text: 'two' })
    backend.calls.length = 0

    const messages = await api.loadChat({ projectId: 'default', chatId, limit: 1 })
    expect(backend.calls).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: `/projects/${backend.theChat().projectId}/chats/${backend.theChat().id}?limit=1`,
      }),
    ])
    expect(messages.map((m) => m.text)).toEqual(['two']) // most recent N, ascending
  })

  it('answers [] for an id it never mapped, without any request', async () => {
    await expect(api.loadChat({ projectId: 'default', chatId: 'unknown' })).resolves.toEqual([])
    expect(backend.calls).toEqual([])
  })

  it('answers [] when the server no longer has the chat', async () => {
    const chatId = ProjectStore.chatIdForFile('/tmp/i.md')
    await api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'x' })
    backend.chats.delete(backend.theChat().id)
    await expect(api.loadChat({ projectId: 'default', chatId })).resolves.toEqual([])
  })
})

describe('rebindChat (move a temp chat onto its file)', () => {
  it('merges the temp messages into the target, then deletes the source', async () => {
    const tempChatId = 'unsaved-99'
    await api.appendChat({ projectId: 'default', chatId: tempChatId, role: 'user', text: 'q' })
    await api.appendChat({ projectId: 'default', chatId: tempChatId, role: 'assistant', text: 'a' })
    const source = backend.theChat()
    backend.calls.length = 0

    const newFilePath = '/tmp/saved.md'
    const result = await api.rebindChat({
      projectId: 'default',
      tempChatId,
      newFilePath,
    })
    expect(result).toEqual({
      projectId: 'default',
      chatId: ProjectStore.chatIdForFile(newFilePath),
    })

    const puts = callsOf('PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].path).not.toBe(`/projects/${source.projectId}/chats/${source.id}`)
    // moved messages carry no client seq and keep their timestamps
    expect(puts[0].body).toEqual({
      messages: [
        { role: 'user', text: 'q', ts: source.messages[0].ts },
        { role: 'assistant', text: 'a', ts: source.messages[1].ts },
      ],
    })
    expect(puts[0].ifMatch).toBe('1') // the fresh target row's version
    expect(callsOf('DELETE').map((c) => c.path)).toEqual([
      `/projects/${source.projectId}/chats/${source.id}`,
    ])
    // the temp id is gone from the index; the file id resolves to the moved chat
    await expect(api.loadChat({ projectId: 'default', chatId: tempChatId })).resolves.toEqual([])
    await expect(
      api.loadChat({ projectId: 'default', chatId: ProjectStore.chatIdForFile(newFilePath) }),
    ).resolves.toHaveLength(2)
  })

  it('appends the moved messages after a target that already has history', async () => {
    const tempChatId = 'unsaved-100'
    const filePath = '/tmp/existing.md'
    await api.appendChat({ projectId: 'default', chatId: tempChatId, role: 'user', text: 'moved' })
    await api.appendChat({
      projectId: 'default',
      chatId: ProjectStore.chatIdForFile(filePath),
      role: 'user',
      text: 'old',
    })
    backend.calls.length = 0

    await api.rebindChat({ projectId: 'default', tempChatId, newFilePath: filePath })
    const put = callsOf('PUT')[0]
    expect(put.body).toEqual({
      messages: [
        expect.objectContaining({ text: 'old' }),
        expect.objectContaining({ text: 'moved' }),
      ],
    })
  })

  it('is a no-op when there is nothing buffered remotely', async () => {
    await expect(
      api.rebindChat({ projectId: 'default', tempChatId: 'unsaved-1', newChatId: 'abc' }),
    ).resolves.toEqual({ projectId: 'default', chatId: 'abc' })
    expect(backend.calls).toEqual([])
  })

  it('surfaces a target conflict instead of merging silently', async () => {
    const tempChatId = 'unsaved-101'
    const filePath = '/tmp/conflict.md'
    await api.appendChat({ projectId: 'default', chatId: tempChatId, role: 'user', text: 'moved' })
    await api.appendChat({
      projectId: 'default',
      chatId: ProjectStore.chatIdForFile(filePath),
      role: 'user',
      text: 'target',
    })
    const target = backend.lastChat()
    backend.onPut = () => {
      target.version += 1
      backend.onPut = undefined
    }
    await expect(
      api.rebindChat({ projectId: 'default', tempChatId, newFilePath: filePath }),
    ).rejects.toBeInstanceOf(RemoteProjectConflictError)
    // both rows keep their own messages: nothing was merged or overwritten
    expect([...backend.chats.values()].map((chat) => chat.messages.map((m) => m.text))).toEqual([
      ['moved'],
      ['target'],
    ])
  })
})

describe('failure classification (the routing layer branches on it)', () => {
  it('maps a transport failure to unavailable', async () => {
    backend.offline = true
    await expect(
      api.appendChat({ projectId: 'default', chatId: 'x1', role: 'user', text: 'x' }),
    ).rejects.toBeInstanceOf(RemoteProjectUnavailableError)
  })

  it('maps a 5xx and a dead-session 401 to unavailable', async () => {
    const statuses = [500, 401]
    let index = 0
    const scripted: RemoteProjectTransport = (path, init) => {
      void path
      void init
      const status = statuses[Math.min(index, statuses.length - 1)]
      index += 1
      return Promise.resolve(new Response('boom', { status }))
    }
    const failing = new RemoteProjectApi({ transport: scripted, indexPath })
    for (const chatId of ['y1', 'y2']) {
      const error = (await failing
        .appendChat({ projectId: 'default', chatId, role: 'user', text: 'x' })
        .catch((err: unknown) => err)) as RemoteProjectError
      expect(error).toBeInstanceOf(RemoteProjectUnavailableError)
      expect(error.code).toBe('unavailable')
      expect(error.status).toBe(statuses[index - 1])
    }
  })
})
