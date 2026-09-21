/**
 * Auth IPC wire contract (apps/shell/src/main/auth/ipc.ts) — the Phase 3
 * final-review fold-in: an electron-mocked `ipcMain` plus a fake session
 * manager assert that every request channel zod-validates its payload
 * before anything reaches the manager, and that malformed payloads reject
 * without side effects (the tests/mcp/sheets-bridge.test.ts pattern).
 *
 * Push channels are covered on their send path: the session-changed
 * broadcast and the login-event stream parse before crossing to any
 * webContents, so a shape bug fails loudly instead of drifting.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_CHANNELS, type AuthSessionSnapshot } from '../src/shared/auth-api'

// ── electron mock: captured handlers + one live webContents ──────────────

type Handler = (event: { sender: FakeSender }, payload?: unknown) => unknown

const handlers = new Map<string, Handler>()
const senderSend = vi.fn()
let senderDestroyed = false

interface FakeSender {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
}
const sender: FakeSender = {
  id: 7,
  isDestroyed: () => senderDestroyed,
  send: senderSend,
}

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    isPackaged: false,
  },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
  safeStorage: {
    // plain-file mode: the test never persists anything anyway
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from('x'),
    decryptString: () => '',
  },
  shell: { openExternal: vi.fn().mockReturnValue(Promise.resolve()) },
  webContents: { getAllWebContents: () => [sender] },
}))

// ── fake manager (the only session implementation the module may talk to) ─

interface FakeManager {
  startLogin: ReturnType<typeof vi.fn>
  cancelLogin: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
  snapshot: ReturnType<typeof vi.fn>
  openVerificationPage: ReturnType<typeof vi.fn>
  onLoginEvent: ReturnType<typeof vi.fn>
  onSessionChanged: ReturnType<typeof vi.fn>
}

/** the instance of the mocked manager the module under test constructed */
const managerRef: { current?: FakeManager } = {}
const manager = (): FakeManager => {
  if (managerRef.current === undefined) throw new Error('no manager was constructed')
  return managerRef.current
}

vi.mock('../src/main/auth/session-manager', () => ({
  AuthSessionManager: class {
    startLogin = vi.fn().mockResolvedValue(undefined)
    cancelLogin = vi.fn()
    logout = vi.fn().mockResolvedValue(undefined)
    snapshot = vi.fn((): AuthSessionSnapshot => ({ status: 'anonymous', storage: 'plain-file' }))
    openVerificationPage = vi.fn().mockReturnValue({ ok: false, error: 'no-login-in-flight' })
    onLoginEvent = vi.fn().mockReturnValue(vi.fn())
    onSessionChanged = vi.fn().mockReturnValue(vi.fn())

    constructor() {
      managerRef.current = this as unknown as FakeManager
    }
  },
}))

// ── fake backend client (probe results scripted per test) ────────────────

let backendProbe: () => Promise<unknown>
let backendCreateCalls = 0

vi.mock('../src/main/auth/backend-client', () => ({
  BackendClientError: class extends Error {},
  BackendClient: {
    create: async () => {
      backendCreateCalls += 1
      return {
        fetch: vi.fn(),
        probe: () => backendProbe(),
      }
    },
  },
}))

const ANONYMOUS: AuthSessionSnapshot = { status: 'anonymous', storage: 'plain-file' }
const AUTHENTICATED: AuthSessionSnapshot = {
  status: 'authenticated',
  profile: { sub: 'user-1', name: 'Test User', roles: ['default-roles-genoffice'] },
  storage: 'plain-file',
}

/** request channels: everything but the two push channels */
const REQUEST_CHANNELS = [
  AUTH_CHANNELS.login,
  AUTH_CHANNELS.cancelLogin,
  AUTH_CHANNELS.logout,
  AUTH_CHANNELS.getSession,
  AUTH_CHANNELS.openVerificationPage,
  AUTH_CHANNELS.probeBackend,
] as const

async function loadIpc() {
  vi.resetModules()
  handlers.clear()
  senderSend.mockClear()
  backendCreateCalls = 0
  backendProbe = async () => ({ ok: true, status: 200 })
  const module = await import('../src/main/auth/ipc')
  module.registerAuthIpc({ tokenStorePath: join(userDataDir, 'cloud-auth.json') })
  return module
}

/** Invoke a registered handler the way ipcMain would (sync throws become rejections). */
function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`)
  return Promise.resolve().then(() => handler({ sender }, payload))
}

describe('auth ipc wire contract', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'auth-ipc-wire-'))
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

  it('passes well-formed (absent) payloads through to the manager', async () => {
    await loadIpc()
    manager().snapshot.mockReturnValue(AUTHENTICATED)
    manager().openVerificationPage.mockReturnValue({ ok: true })

    await expect(invoke(AUTH_CHANNELS.login)).resolves.toBeUndefined()
    expect(manager().startLogin).toHaveBeenCalledTimes(1)

    await expect(invoke(AUTH_CHANNELS.cancelLogin)).resolves.toBeUndefined()
    expect(manager().cancelLogin).toHaveBeenCalledTimes(1)

    await expect(invoke(AUTH_CHANNELS.logout)).resolves.toBeUndefined()
    expect(manager().logout).toHaveBeenCalledTimes(1)

    await expect(invoke(AUTH_CHANNELS.getSession)).resolves.toEqual(AUTHENTICATED)

    await expect(invoke(AUTH_CHANNELS.openVerificationPage)).resolves.toEqual({ ok: true })

    await expect(invoke(AUTH_CHANNELS.probeBackend)).resolves.toEqual({ ok: true, status: 200 })
    expect(backendCreateCalls).toBe(1) // the shared lazy client
  })

  it('rejects malformed payloads on every request channel, before the manager', async () => {
    await loadIpc()
    for (const channel of REQUEST_CHANNELS) {
      for (const payload of [{}, { extra: 1 }, 'nope', 42]) {
        await expect(
          invoke(channel, payload),
          `${channel} ${JSON.stringify(payload)}`,
        ).rejects.toThrow()
      }
    }
    expect(manager().startLogin).not.toHaveBeenCalled()
    expect(manager().cancelLogin).not.toHaveBeenCalled()
    expect(manager().logout).not.toHaveBeenCalled()
    expect(manager().snapshot).not.toHaveBeenCalled()
    expect(manager().openVerificationPage).not.toHaveBeenCalled()
    expect(backendCreateCalls).toBe(0)
  })

  it('builds the session snapshot strictly (unknown fields reject at the edge)', async () => {
    await loadIpc()
    manager().snapshot.mockReturnValue({
      status: 'authenticated',
      storage: 'plain-file',
      accessToken: 'should-not-cross', // a token smuggled into the snapshot
    } as unknown as AuthSessionSnapshot)
    await expect(invoke(AUTH_CHANNELS.getSession)).rejects.toThrow()
  })

  it('answers probe-backend with {ok:false} when the client cannot be built', async () => {
    await loadIpc()
    backendProbe = async () => {
      throw new Error('construction failed')
    }
    await expect(invoke(AUTH_CHANNELS.probeBackend)).resolves.toEqual({ ok: false })
  })

  it('broadcasts session changes to every webContents, validated', async () => {
    await loadIpc()
    const broadcast = manager().onSessionChanged.mock.calls[0][0] as (payload: unknown) => void

    broadcast({ status: 'authenticated' })
    expect(senderSend).toHaveBeenCalledWith(AUTH_CHANNELS.sessionChanged, {
      status: 'authenticated',
    })

    expect(() => broadcast({ status: 'somewhere-else' })).toThrow()
    expect(() => broadcast({ status: 'authenticated', accessToken: 'x' })).toThrow()
  })

  it('streams login progress to the requesting webContents only, validated', async () => {
    await loadIpc()
    // the subscription happens inside the auth:login handler
    await invoke(AUTH_CHANNELS.login)
    const forward = manager().onLoginEvent.mock.calls[0][0] as (payload: unknown) => void

    forward({
      status: 'waiting-for-confirmation',
      userCode: 'ABCD-EFGH',
      expiresAt: 1_900_000_000_000,
    })
    expect(senderSend).toHaveBeenCalledWith(AUTH_CHANNELS.loginEvent, {
      status: 'waiting-for-confirmation',
      userCode: 'ABCD-EFGH',
      expiresAt: 1_900_000_000_000,
    })

    // a destroyed sender is skipped, not crashed on
    senderDestroyed = true
    expect(() => forward({ status: 'failure', error: 'network_error' })).not.toThrow()
    senderDestroyed = false

    // no URL, token, or free-form field ever crosses
    expect(() =>
      forward({ status: 'waiting-for-confirmation', userCode: 'X', verificationUrl: 'http://x' }),
    ).toThrow()
  })

  it('registers exactly once (idempotent)', async () => {
    const module = await loadIpc()
    const first = manager()
    module.registerAuthIpc({ tokenStorePath: join(userDataDir, 'cloud-auth.json') })
    expect(manager()).toBe(first) // the second call built no new manager
  })

  it('exposes the session manager and backend client seams for main-process consumers', async () => {
    const module = await loadIpc()
    expect(module.getAuthSessionManager()).toBeDefined()
    await expect(module.getBackendClient()).resolves.toBeDefined()
    expect(module.getAuthSessionManager()?.snapshot()).toEqual(ANONYMOUS)
  })
})
