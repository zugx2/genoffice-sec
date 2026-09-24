/**
 * Cloud-docs IPC wire contract (src/main/auth/cloud-docs-ipc.ts) — the
 * auth-ipc-wire.test.ts pattern: an electron-mocked `ipcMain` plus a fake
 * registry assert that every channel zod-validates its payload before
 * anything reaches the registry, that malformed payloads reject without
 * side effects, and that the push channel parses before crossing to any
 * webContents (so a shape bug fails loudly instead of drifting).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_DOCS_CHANNELS } from '../src/shared/cloud-docs-api'
import type { CloudDocumentsSnapshot } from '../src/shared/cloud-docs-api'

// ── electron mock: captured handlers + one live webContents ──────────────

type Handler = (event: { sender: unknown }, payload?: unknown) => unknown

const handlers = new Map<string, Handler>()
const senderSend = vi.fn()

interface FakeSender {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
}
const sender: FakeSender = { id: 7, isDestroyed: () => false, send: senderSend }

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
  webContents: { getAllWebContents: () => [sender] },
}))

// ── fake auth seams (the module may only talk to these) ──────────────────

let sessionStatus: 'authenticated' | 'anonymous' = 'anonymous'
/** the session-manager subscription the module registers (captured per load) */
let sessionHandler: ((payload: { status: string }) => void) | undefined

vi.mock('../src/main/auth/ipc', () => ({
  getAuthSessionManager: () => ({
    snapshot: () =>
      sessionStatus === 'authenticated'
        ? { status: 'authenticated', profile: { sub: 'user-1', roles: [] } }
        : { status: 'anonymous' },
    onSessionChanged: (handler: (payload: { status: string }) => void) => {
      sessionHandler = handler
      return () => {}
    },
  }),
  getBackendClient: () => undefined,
}))

// ── fake registry (the only document implementation it may construct) ────

const registryRef: { current?: FakeRegistry } = {}
const registry = (): FakeRegistry => {
  if (registryRef.current === undefined) throw new Error('no registry was constructed')
  return registryRef.current
}

class FakeRegistry {
  snapshotMock: CloudDocumentsSnapshot = {
    available: false,
    documents: [],
    syncedAt: 0,
    stale: false,
    pendingStars: 0,
  }
  autoRefresh = vi.fn(async (): Promise<CloudDocumentsSnapshot> => this.snapshotMock)
  refresh = vi.fn(async (): Promise<CloudDocumentsSnapshot> => this.snapshotMock)
  sessionChanged = vi.fn()
  toggleStarred = vi.fn(async (): Promise<CloudDocumentsSnapshot> => this.snapshotMock)
  markOpened = vi.fn(async (): Promise<void> => undefined)
  onChange = vi.fn().mockReturnValue(vi.fn())
  onDocumentRekeyed = vi.fn().mockReturnValue(vi.fn())
  rekeyDocument = vi.fn()
  document = vi.fn()
  dispose = vi.fn()

  constructor(public readonly options: unknown) {
    registryRef.current = this
  }

  snapshot(): CloudDocumentsSnapshot {
    return this.snapshotMock
  }
}

vi.mock('../src/main/auth/cloud-docs', () => ({
  CloudDocumentsRegistry: FakeRegistry,
}))

const AVAILABLE: CloudDocumentsSnapshot = {
  available: true,
  documents: [
    {
      cloudId: '11111111-2222-4333-8444-555555555555',
      name: 'note.md',
      kind: 'md',
      sizeBytes: 12,
      currentVersion: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      starred: true,
      lastOpenedAt: '2026-01-03T00:00:00.000Z',
    },
  ],
  syncedAt: 1_700_000_000_000,
  stale: false,
  pendingStars: 0,
}

const REQUEST_CHANNELS = [
  CLOUD_DOCS_CHANNELS.listDocuments,
  CLOUD_DOCS_CHANNELS.toggleStarred,
  CLOUD_DOCS_CHANNELS.markOpened,
] as const

async function loadIpc() {
  vi.resetModules()
  handlers.clear()
  senderSend.mockClear()
  sessionStatus = 'anonymous'
  sessionHandler = undefined
  const module = await import('../src/main/auth/cloud-docs-ipc')
  module.registerCloudDocsIpc({ storePath: join(userDataDir, 'cloud-documents.json') })
  return module
}

/** Invoke a registered handler the way ipcMain would (sync throws → rejections). */
function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`)
  return Promise.resolve().then(() => handler({ sender }, payload))
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('cloud-docs ipc wire contract', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'cloud-docs-ipc-'))
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('registers a handler for every request channel', async () => {
    await loadIpc()
    for (const channel of REQUEST_CHANNELS) {
      expect(handlers.has(channel), channel).toBe(true)
    }
    expect(handlers.size).toBe(REQUEST_CHANNELS.length)
  })

  it('registers exactly once (idempotent) and exposes the registry seam', async () => {
    const module = await loadIpc()
    const first = registry()
    module.registerCloudDocsIpc({ storePath: join(userDataDir, 'other.json') })
    expect(registry()).toBe(first) // the second call built no new registry
    expect(module.getCloudDocumentsRegistry()).toBe(first)
  })

  it('serves the cached snapshot without kicking anything while signed out', async () => {
    await loadIpc()
    await expect(invoke(CLOUD_DOCS_CHANNELS.listDocuments)).resolves.toEqual({
      available: false,
      documents: [],
      syncedAt: 0,
      stale: false,
      pendingStars: 0,
    })
    await flush()
    expect(registry().autoRefresh).not.toHaveBeenCalled()
    expect(registry().refresh).not.toHaveBeenCalled()
  })

  it('kicks the rate-limited background refresh on list while signed in (cache still served)', async () => {
    await loadIpc()
    sessionStatus = 'authenticated'
    const result = await invoke(CLOUD_DOCS_CHANNELS.listDocuments)
    expect(result).toMatchObject({ available: false }) // the cached answer
    await flush()
    // the kick goes through autoRefresh (the interval-gated variant), so a
    // live section's list → push → list cycle cannot become a fetch loop
    expect(registry().autoRefresh).toHaveBeenCalledTimes(1)
    expect(registry().refresh).not.toHaveBeenCalled()
  })

  it('validates the snapshot before it crosses to the renderer', async () => {
    await loadIpc()
    // a well-formed snapshot passes through byte-for-byte
    registry().snapshotMock = AVAILABLE
    await expect(invoke(CLOUD_DOCS_CHANNELS.listDocuments)).resolves.toEqual(AVAILABLE)
    // a smuggled extra field (or a non-string id) fails loudly at the edge
    registry().snapshotMock = { ...AVAILABLE, endpointUrl: 'https://backend' } as never
    await expect(invoke(CLOUD_DOCS_CHANNELS.listDocuments)).rejects.toThrow()
    registry().snapshotMock = {
      ...AVAILABLE,
      documents: [{ ...AVAILABLE.documents[0], cloudId: 42 }] as never,
    }
    await expect(invoke(CLOUD_DOCS_CHANNELS.listDocuments)).rejects.toThrow()
  })

  it('passes a well-formed star toggle through and returns the new snapshot', async () => {
    await loadIpc()
    registry().snapshotMock = AVAILABLE
    const cloudId = AVAILABLE.documents[0].cloudId
    const result = await invoke(CLOUD_DOCS_CHANNELS.toggleStarred, {
      cloudId,
      starred: false,
    })
    expect(registry().toggleStarred).toHaveBeenCalledWith(cloudId, false)
    expect(result).toEqual(AVAILABLE)
  })

  it('rejects malformed payloads on every request channel, before the registry', async () => {
    await loadIpc()
    // list takes no arguments
    for (const payload of [{}, { extra: 1 }, 'nope', 42]) {
      await expect(
        invoke(CLOUD_DOCS_CHANNELS.listDocuments, payload),
        `list ${JSON.stringify(payload)}`,
      ).rejects.toThrow()
    }
    // star toggle: strict {cloudId, starred}
    for (const payload of [
      undefined,
      {},
      { cloudId: '' },
      { cloudId: 'x'.repeat(129) },
      { cloudId: 'doc-1' },
      { cloudId: 'doc-1', starred: 'true' },
      { cloudId: 'doc-1', starred: 1 },
      { cloudId: 'doc-1', starred: true, extra: 1 },
      { starred: true },
    ]) {
      await expect(
        invoke(CLOUD_DOCS_CHANNELS.toggleStarred, payload),
        `star ${JSON.stringify(payload)}`,
      ).rejects.toThrow()
    }
    // mark opened: strict {cloudId}
    for (const payload of [
      undefined,
      {},
      { cloudId: '' },
      { cloudId: 5 },
      { cloudId: 'd', x: 1 },
    ]) {
      await expect(
        invoke(CLOUD_DOCS_CHANNELS.markOpened, payload),
        `opened ${JSON.stringify(payload)}`,
      ).rejects.toThrow()
    }
    expect(registry().toggleStarred).not.toHaveBeenCalled()
    expect(registry().markOpened).not.toHaveBeenCalled()
  })

  it('passes a well-formed open stamp through to the registry', async () => {
    await loadIpc()
    await invoke(CLOUD_DOCS_CHANNELS.markOpened, { cloudId: 'doc-1' })
    expect(registry().markOpened).toHaveBeenCalledWith('doc-1')
  })

  it('broadcasts registry changes to every webContents, validated', async () => {
    await loadIpc()
    const broadcast = registry().onChange.mock.calls[0][0] as (reason: unknown) => void

    broadcast('refreshed')
    expect(senderSend).toHaveBeenCalledWith(CLOUD_DOCS_CHANNELS.documentsChanged, {
      reason: 'refreshed',
    })
    broadcast('starred')
    expect(senderSend).toHaveBeenLastCalledWith(CLOUD_DOCS_CHANNELS.documentsChanged, {
      reason: 'starred',
    })

    // no URL, token, or free-form reason ever crosses
    expect(() => broadcast('something-else')).toThrow()
    expect(() => broadcast({ reason: 'refreshed', url: 'https://x' })).toThrow()
  })

  it('binds the registry to the session seam and the shared client', async () => {
    await loadIpc()
    sessionStatus = 'authenticated'
    const options = registry().options as {
      session: { currentSub: () => string | null }
      storePath: string
    }
    expect(options.session.currentSub()).toBe('user-1')
    sessionStatus = 'anonymous'
    expect(options.session.currentSub()).toBeNull()
    expect(options.storePath).toBe(join(userDataDir, 'cloud-documents.json'))
  })

  it('forwards session changes to the registry (the sign-out trigger)', async () => {
    await loadIpc()
    expect(sessionHandler).toBeDefined() // subscribed at registration
    sessionHandler!({ status: 'anonymous' })
    expect(registry().sessionChanged).toHaveBeenCalledTimes(1)
    // and again on the next transition (an account switch)
    sessionHandler!({ status: 'authenticated' })
    expect(registry().sessionChanged).toHaveBeenCalledTimes(2)
  })
})
