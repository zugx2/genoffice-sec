/**
 * Project-store routing (apps/shell/src/main/auth/project-routing.ts).
 *
 * Pins the Phase 6b routing contract: session active → remote, no session →
 * local, request-level offline fallback (remote unavailable → re-serve that
 * request locally with a flagged source), and — the security-relevant half —
 * that a definitive remote answer (the typed 409 conflict above all) is
 * surfaced instead of being quietly re-served from the local store.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ProjectApi } from '@genoffice/project-store'
import {
  RemoteProjectApiError,
  RemoteProjectConflictError,
  RemoteProjectUnavailableError,
} from '@genoffice/project-store'
import { RoutingProjectApi } from '../src/main/auth/project-routing'

/** A ProjectApi double that tags everything it serves with its name. */
function fakeApi(tag: 'local' | 'remote'): ProjectApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    resolveChat: async (args) => {
      calls.push(`resolveChat:${args.filePath ?? args.tempChatId ?? ''}`)
      return { projectId: tag, chatId: (args.filePath ?? args.tempChatId ?? 'id')! }
    },
    appendChat: async (args) => {
      calls.push(`appendChat:${args.chatId}`)
    },
    loadChat: async (args) => {
      calls.push(`loadChat:${args.chatId}`)
      const message: ChatMessage = {
        seq: 1,
        ts: '2026-01-01T00:00:00.000Z',
        role: 'user',
        text: tag,
      }
      return [message]
    },
    rebindChat: async (args) => {
      calls.push(`rebindChat:${args.tempChatId}`)
      return { projectId: tag, chatId: args.newChatId ?? 'rebound' }
    },
  }
}

function makeRouter(options: {
  sessionActive: () => boolean
  remote: () => Promise<ProjectApi | undefined>
}) {
  return new RoutingProjectApi({ local: fakeApi('local'), ...options })
}

describe('the switch (login → remote, logout → local)', () => {
  it('serves local while anonymous and never builds the remote adapter', async () => {
    const remote = vi.fn(async () => fakeApi('remote') as ProjectApi)
    const router = makeRouter({ sessionActive: () => false, remote })

    expect(router.projectStoreSource()).toBe('local')
    const messages = await router.loadChat({ projectId: 'default', chatId: 'c1' })
    expect(messages[0].text).toBe('local')
    expect(router.lastRequestSource()).toBe('local')
    expect(remote).not.toHaveBeenCalled()
  })

  it('serves remote while a session is active', async () => {
    const remoteApi = fakeApi('remote')
    const router = makeRouter({ sessionActive: () => true, remote: async () => remoteApi })

    expect(router.projectStoreSource()).toBe('remote')
    const messages = await router.loadChat({ projectId: 'default', chatId: 'c1' })
    expect(messages[0].text).toBe('remote')
    expect(router.lastRequestSource()).toBe('remote')
  })

  it('flips both directions with the session', async () => {
    const remoteApi = fakeApi('remote')
    let active = false
    const router = makeRouter({ sessionActive: () => active, remote: async () => remoteApi })

    expect((await router.loadChat({ projectId: 'default', chatId: 'c' }))[0].text).toBe('local')
    active = true // login
    expect(router.projectStoreSource()).toBe('remote')
    expect((await router.loadChat({ projectId: 'default', chatId: 'c' }))[0].text).toBe('remote')
    active = false // logout
    expect(router.projectStoreSource()).toBe('local')
    expect((await router.loadChat({ projectId: 'default', chatId: 'c' }))[0].text).toBe('local')
  })
})

describe('request-level offline fallback', () => {
  it('re-serves a single request locally when the remote store is unavailable', async () => {
    const remoteApi = fakeApi('remote')
    let failNext = true
    remoteApi.loadChat = async () => {
      if (failNext) {
        failNext = false
        throw new RemoteProjectUnavailableError('backend down')
      }
      return [{ seq: 1, ts: 't', role: 'user', text: 'remote' }]
    }
    const router = makeRouter({ sessionActive: () => true, remote: async () => remoteApi })

    const first = await router.loadChat({ projectId: 'default', chatId: 'c1' })
    expect(first[0].text).toBe('local') // served by the fallback
    expect(router.lastRequestSource()).toBe('remote-fallback-local')

    // the fallback is request-level: the next request retries remote
    const second = await router.loadChat({ projectId: 'default', chatId: 'c1' })
    expect(second[0].text).toBe('remote')
    expect(router.lastRequestSource()).toBe('remote')
  })

  it('stays local when the remote adapter cannot be built (config-gated client)', async () => {
    const router = makeRouter({ sessionActive: () => true, remote: async () => undefined })
    const messages = await router.loadChat({ projectId: 'default', chatId: 'c1' })
    expect(messages[0].text).toBe('local')
    expect(router.lastRequestSource()).toBe('remote-fallback-local')
  })

  it('builds the remote adapter only once, even after failures', async () => {
    const remote = vi.fn(async () => fakeApi('remote') as ProjectApi)
    const router = makeRouter({ sessionActive: () => true, remote })
    await router.loadChat({ projectId: 'default', chatId: 'c1' })
    await router.loadChat({ projectId: 'default', chatId: 'c1' })
    expect(remote).toHaveBeenCalledTimes(1)
  })
})

describe('definitive remote answers surface (no silent local re-write)', () => {
  it('rethrows a typed conflict without touching the local store', async () => {
    const remoteApi = fakeApi('remote')
    remoteApi.appendChat = async () => {
      throw new RemoteProjectConflictError()
    }
    const local = fakeApi('local')
    const router = new RoutingProjectApi({
      local,
      sessionActive: () => true,
      remote: async () => remoteApi,
    })

    await expect(
      router.appendChat({ projectId: 'default', chatId: 'c1', role: 'user', text: 'x' }),
    ).rejects.toBeInstanceOf(RemoteProjectConflictError)
    expect(local.calls).toEqual([]) // nothing was written behind the caller's back
    expect(router.lastRequestSource()).toBe('remote')
  })

  it('rethrows other definitive rejections (404) the same way', async () => {
    const remoteApi = fakeApi('remote')
    remoteApi.loadChat = async () => {
      throw new RemoteProjectApiError('not found', { status: 404 })
    }
    const router = makeRouter({ sessionActive: () => true, remote: async () => remoteApi })
    await expect(router.loadChat({ projectId: 'default', chatId: 'c1' })).rejects.toMatchObject({
      code: 'http_error',
      status: 404,
    })
    expect(router.lastRequestSource()).toBe('remote')
  })
})

describe('all four operations route through the same decision', () => {
  it('delegates resolveChat/appendChat/loadChat/rebindChat per request', async () => {
    const local = fakeApi('local')
    const remoteApi = fakeApi('remote')
    let active = true
    const router = new RoutingProjectApi({
      local,
      sessionActive: () => active,
      remote: async () => remoteApi,
    })

    await router.resolveChat({ filePath: '/tmp/a.md' })
    await router.appendChat({ projectId: 'default', chatId: 'c1', role: 'user', text: 'x' })
    await router.loadChat({ projectId: 'default', chatId: 'c1' })
    await router.rebindChat({ projectId: 'default', tempChatId: 't', newChatId: 'n' })
    expect(remoteApi.calls).toEqual([
      'resolveChat:/tmp/a.md',
      'appendChat:c1',
      'loadChat:c1',
      'rebindChat:t',
    ])
    expect(local.calls).toEqual([])

    active = false
    await router.resolveChat({ filePath: '/tmp/b.md' })
    expect(local.calls).toEqual(['resolveChat:/tmp/b.md'])
  })
})
