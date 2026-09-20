import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthApi } from '../src/shared/auth-api'
import { AUTH_CHANNELS } from '../src/shared/auth-api'

const electronMocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => electronMocks.exposed.set(name, api),
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
  // the preload imports @genoffice/electron-utils (drop-open bridge), which
  // binds webUtils at module scope even though node env never installs it
  webUtils: { getPathForFile: () => '' },
}))

import '../src/preload/index'

const authApi = electronMocks.exposed.get('aiOfficeAuth') as AuthApi

beforeEach(() => {
  electronMocks.invoke.mockReset()
  electronMocks.on.mockReset()
  electronMocks.removeListener.mockReset()
})

describe('cloud-auth preload bridge', () => {
  it('exposes exactly the six auth methods and nothing else', () => {
    expect(authApi).toBeTruthy()
    expect(Object.keys(authApi).sort()).toEqual([
      'cancelLogin',
      'getSession',
      'login',
      'logout',
      'onLoginEvent',
      'onSessionChanged',
    ])
  })

  it('invokes the four request channels unchanged', async () => {
    electronMocks.invoke.mockResolvedValue(undefined)

    await authApi.login()
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(AUTH_CHANNELS.login)

    await authApi.cancelLogin()
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(AUTH_CHANNELS.cancelLogin)

    await authApi.logout()
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(AUTH_CHANNELS.logout)
  })

  it('returns the session snapshot from auth:get-session', async () => {
    const snapshot = {
      status: 'authenticated',
      profile: { sub: 'user-1', roles: ['admin'] },
      storage: 'encrypted',
    }
    electronMocks.invoke.mockResolvedValue(snapshot)

    await expect(authApi.getSession()).resolves.toEqual(snapshot)
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(AUTH_CHANNELS.getSession)
  })

  it('forwards login events to the handler and unsubscribes with the same listener', () => {
    const handler = vi.fn()
    electronMocks.on.mockReturnValue(undefined)

    const unsubscribe = authApi.onLoginEvent(handler)

    const channel = electronMocks.on.mock.calls[0][0]
    const listener = electronMocks.on.mock.calls[0][1]
    expect(channel).toBe(AUTH_CHANNELS.loginEvent)

    listener(undefined, { status: 'waiting-for-confirmation', userCode: 'ABCD-EFGH', expiresAt: 1 })
    expect(handler).toHaveBeenCalledWith({
      status: 'waiting-for-confirmation',
      userCode: 'ABCD-EFGH',
      expiresAt: 1,
    })

    unsubscribe()
    expect(electronMocks.removeListener).toHaveBeenCalledWith(AUTH_CHANNELS.loginEvent, listener)
  })

  it('forwards session changes to the handler and unsubscribes with the same listener', () => {
    const handler = vi.fn()
    electronMocks.on.mockReturnValue(undefined)

    const unsubscribe = authApi.onSessionChanged(handler)

    const channel = electronMocks.on.mock.calls[0][0]
    const listener = electronMocks.on.mock.calls[0][1]
    expect(channel).toBe(AUTH_CHANNELS.sessionChanged)

    listener(undefined, { status: 'anonymous' })
    expect(handler).toHaveBeenCalledWith({ status: 'anonymous' })

    unsubscribe()
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      AUTH_CHANNELS.sessionChanged,
      listener,
    )
  })
})
