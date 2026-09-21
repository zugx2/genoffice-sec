/**
 * Local `ProjectApi` adapter tests: the four operations over a real
 * `ProjectStore` in a temp directory. These pin the semantics the IPC
 * handlers had before the adapter existed, so the routing layer can swap
 * implementations without behavior drifting.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalProjectApi } from '../src/local.js'
import { ProjectStore } from '../src/store.js'

let dir: string
let store: ProjectStore
let api: LocalProjectApi

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-project-api-'))
  store = new ProjectStore(dir)
  api = new LocalProjectApi(store)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveChat', () => {
  it('answers an unsaved file with the default project and a temp id', async () => {
    await expect(api.resolveChat({ filePath: null, tempChatId: 'unsaved-7' })).resolves.toEqual({
      projectId: 'default',
      chatId: 'unsaved-7',
    })
    const generated = await api.resolveChat({ filePath: null })
    expect(generated.projectId).toBe('default')
    expect(generated.chatId).toMatch(/^unsaved-\d+$/)
  })

  it('registers a saved file into the default project with a stable id', async () => {
    const first = await api.resolveChat({ filePath: '/tmp/doc.md' })
    const second = await api.resolveChat({ filePath: '/tmp/doc.md' })
    expect(first).toEqual({
      projectId: 'default',
      chatId: ProjectStore.chatIdForFile('/tmp/doc.md'),
    })
    expect(second).toEqual(first)
    // listProjectFiles filters paths that no longer exist on disk, so the
    // registration is asserted through the stored record
    expect(store.getProject('default')?.files).toEqual(['/tmp/doc.md'])
  })
})

describe('appendChat + loadChat', () => {
  it('round-trips messages with store-assigned seq in arrival order', async () => {
    const { chatId } = await api.resolveChat({ filePath: '/tmp/rt.md' })
    await api.appendChat({ projectId: 'default', chatId, role: 'user', text: 'one' })
    await api.appendChat({ projectId: 'default', chatId, role: 'assistant', text: 'two' })
    const messages = await api.loadChat({ projectId: 'default', chatId })
    expect(messages.map((m) => [m.seq, m.role, m.text])).toEqual([
      [0, 'user', 'one'],
      [1, 'assistant', 'two'],
    ])
  })

  it('defaults the load limit to the most recent 200 messages', async () => {
    const { chatId } = await api.resolveChat({ filePath: '/tmp/limit.md' })
    for (let i = 1; i <= 3; i++) {
      await api.appendChat({ projectId: 'default', chatId, role: 'user', text: `m${i}` })
    }
    const limited = await api.loadChat({ projectId: 'default', chatId, limit: 2 })
    expect(limited.map((m) => m.text)).toEqual(['m2', 'm3'])
  })
})

describe('rebindChat', () => {
  it('moves a temp chat onto the saved file id once it exists', async () => {
    const temp = await api.resolveChat({ filePath: null, tempChatId: 'unsaved-t' })
    await api.appendChat({
      projectId: temp.projectId,
      chatId: temp.chatId,
      role: 'user',
      text: 'q',
    })
    await api.appendChat({
      projectId: temp.projectId,
      chatId: temp.chatId,
      role: 'assistant',
      text: 'a',
    })

    const rebound = await api.rebindChat({
      projectId: temp.projectId,
      tempChatId: temp.chatId,
      newFilePath: '/tmp/saved-later.md',
    })
    expect(rebound).toEqual({
      projectId: 'default',
      chatId: ProjectStore.chatIdForFile('/tmp/saved-later.md'),
    })
    await expect(
      api.loadChat({ projectId: 'default', chatId: rebound.chatId }),
    ).resolves.toHaveLength(2)
  })

  it('renames to an explicit newChatId when no path is given', async () => {
    await api.appendChat({ projectId: 'default', chatId: 'tmp-1', role: 'user', text: 'x' })
    await expect(
      api.rebindChat({ projectId: 'default', tempChatId: 'tmp-1', newChatId: 'fixed-1' }),
    ).resolves.toEqual({ projectId: 'default', chatId: 'fixed-1' })
    await expect(api.loadChat({ projectId: 'default', chatId: 'fixed-1' })).resolves.toHaveLength(1)
  })
})
