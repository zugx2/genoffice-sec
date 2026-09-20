/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useSession,
  type SessionApi,
  type SessionChangedEvent,
  type SessionLoginEvent,
  type SessionSnapshot,
  type UseSessionResult,
} from '../src/session'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const ANONYMOUS: SessionSnapshot = { status: 'anonymous', storage: 'encrypted' }
const AUTHENTICATED: SessionSnapshot = {
  status: 'authenticated',
  storage: 'encrypted',
  profile: { sub: 'user-1', name: 'Alice', email: 'alice@example.test', roles: ['admin'] },
}

/** Mocked `window.aiOfficeAuth`-shaped bridge with recorded subscribers. */
function mockBridge(initial: SessionSnapshot = ANONYMOUS) {
  const loginHandlers = new Set<(event: SessionLoginEvent) => void>()
  const changedHandlers = new Set<(event: SessionChangedEvent) => void>()
  let snapshot = initial
  const api: SessionApi = {
    login: vi.fn(async () => {}),
    cancelLogin: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    getSession: vi.fn(async () => snapshot),
    onLoginEvent: vi.fn((handler: (event: SessionLoginEvent) => void) => {
      loginHandlers.add(handler)
      return () => loginHandlers.delete(handler)
    }),
    onSessionChanged: vi.fn((handler: (event: SessionChangedEvent) => void) => {
      changedHandlers.add(handler)
      return () => changedHandlers.delete(handler)
    }),
  }
  return {
    api,
    setSnapshot(next: SessionSnapshot) {
      snapshot = next
    },
    emitLogin(event: SessionLoginEvent) {
      for (const handler of [...loginHandlers]) handler(event)
    },
    emitChanged(event: SessionChangedEvent) {
      for (const handler of [...changedHandlers]) handler(event)
    },
    get subscriberCounts() {
      return { login: loginHandlers.size, changed: changedHandlers.size }
    },
  }
}

let host: HTMLDivElement
let root: Root
/** latest hook result, refreshed by every render of the probe */
let latest: UseSessionResult

function Probe({ api }: { api: SessionApi | undefined }) {
  latest = useSession(api)
  return null
}

async function mount(api: SessionApi | undefined): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { api }))
    await Promise.resolve()
  })
  await flush()
}

/** let pending promise chains (getSession and friends) land */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  latest = undefined as unknown as UseSessionResult
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useSession', () => {
  it('loads the snapshot on mount and follows session-changed pushes', async () => {
    const bridge = mockBridge(ANONYMOUS)
    await mount(bridge.api)

    expect(latest.session).toEqual(ANONYMOUS)
    expect(bridge.api.getSession).toHaveBeenCalledTimes(1)

    bridge.setSnapshot(AUTHENTICATED)
    act(() => bridge.emitChanged({ status: 'authenticated' }))
    await flush()

    expect(latest.session).toEqual(AUTHENTICATED)
    expect(bridge.api.getSession).toHaveBeenCalledTimes(2)
  })

  it('keeps the last known snapshot when getSession rejects', async () => {
    const bridge = mockBridge(AUTHENTICATED)
    await mount(bridge.api)
    expect(latest.session).toEqual(AUTHENTICATED)

    let injected: ((reason?: unknown) => void) | undefined
    ;(bridge.api.getSession as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          injected = reject
        }),
    )
    await act(async () => {
      bridge.emitChanged({ status: 'anonymous' })
      await Promise.resolve()
      injected?.(new Error('ipc gone'))
      await Promise.resolve()
    })
    await flush()

    expect(latest.session).toEqual(AUTHENTICATED) // unchanged, not wiped
  })

  it('streams login events in order and resets them when a new login starts', async () => {
    const bridge = mockBridge()
    await mount(bridge.api)

    act(() =>
      bridge.emitLogin({
        status: 'waiting-for-confirmation',
        userCode: 'ABCD-EFGH',
        expiresAt: 99,
      }),
    )
    await flush()
    expect(latest.loginEvents).toEqual([
      { status: 'waiting-for-confirmation', userCode: 'ABCD-EFGH', expiresAt: 99 },
    ])

    act(() => bridge.emitLogin({ status: 'failure', error: 'access_denied' }))
    await flush()
    expect(latest.loginEvents.map((e) => e.status)).toEqual(['waiting-for-confirmation', 'failure'])

    await act(async () => {
      await latest.login()
    })
    expect(bridge.api.login).toHaveBeenCalledTimes(1)
    expect(latest.loginEvents).toEqual([]) // fresh attempt drops stale progress
  })

  it('unsubscribes both channels on unmount and ignores later pushes', async () => {
    const bridge = mockBridge()
    await mount(bridge.api)
    expect(bridge.subscriberCounts).toEqual({ login: 1, changed: 1 })

    act(() => root.unmount())
    expect(bridge.subscriberCounts).toEqual({ login: 0, changed: 0 })

    const before = latest.loginEvents
    bridge.emitLogin({ status: 'success' })
    bridge.emitChanged({ status: 'authenticated' })
    await flush()
    expect(latest.loginEvents).toBe(before) // no post-unmount state updates
    expect(bridge.api.getSession).toHaveBeenCalledTimes(1)
  })

  it('does not resubscribe across re-renders with the same bridge reference', async () => {
    const bridge = mockBridge()
    await mount(bridge.api)
    await mount(bridge.api) // same reference: re-render, not a resubscribe

    expect(bridge.api.onLoginEvent).toHaveBeenCalledTimes(1)
    expect(bridge.api.onSessionChanged).toHaveBeenCalledTimes(1)
    expect(bridge.api.getSession).toHaveBeenCalledTimes(1)
    expect(bridge.subscriberCounts).toEqual({ login: 1, changed: 1 })
  })

  it('forwards commands to the bridge and refreshes on demand', async () => {
    const bridge = mockBridge(ANONYMOUS)
    await mount(bridge.api)

    await act(async () => {
      await latest.cancelLogin()
      await latest.logout()
    })
    expect(bridge.api.cancelLogin).toHaveBeenCalledTimes(1)
    expect(bridge.api.logout).toHaveBeenCalledTimes(1)

    bridge.setSnapshot(AUTHENTICATED)
    await act(async () => {
      await latest.refresh()
    })
    expect(latest.session).toEqual(AUTHENTICATED)
  })

  it('stays inert without a bridge (standalone windows)', async () => {
    await mount(undefined)

    expect(latest.session).toBeNull()
    await act(async () => {
      await latest.login() // must not throw
      await latest.refresh()
    })
    expect(latest.session).toBeNull()
    expect(latest.loginEvents).toEqual([])
  })
})
