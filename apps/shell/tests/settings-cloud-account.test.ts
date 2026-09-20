/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { HomeApi } from '../src/shared/home-api'
import type {
  AuthApi,
  AuthBackendProbeResult,
  AuthLoginEventPayload,
  AuthOpenVerificationPageResult,
  AuthSessionChangedPayload,
  AuthSessionSnapshot,
} from '../src/shared/auth-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal, type SettingsModalProps } from '../src/renderer/src/SettingsModal'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  window.aiOffice = {
    getTheme: async () => 'system',
    getDefaultSaveDir: async () => '',
    getAnalyticsEnabled: async () => true,
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
    getAiPanelPrefs: async () => ({ fontSize: 'default', spellcheck: true }),
    getUpdateChannel: async () => 'stable',
    getAppVersion: async () => '1.0.0',
    githubStars: async () => null,
  } as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.aiOfficeAuth = undefined
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLButtonElement).click()
    await Promise.resolve()
  })
  await flush()
}

function buttonWithText(text: string, scope: ParentNode = host): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
}

/** controllable AuthApi double: scripted pushes, deferred login + probe promises */
interface AuthHarness {
  api: AuthApi
  login: Mock
  cancelLogin: Mock
  logout: Mock
  openVerificationPage: Mock
  probeBackend: Mock
  emitLogin: (event: AuthLoginEventPayload) => void
  emitSessionChanged: (payload: AuthSessionChangedPayload) => void
  setSnapshot: (snapshot: AuthSessionSnapshot) => void
  resolveLogin: () => void
  resolveProbe: (result: AuthBackendProbeResult) => void
}

function makeAuth(initial: AuthSessionSnapshot): AuthHarness {
  let snapshot = initial
  const loginHandlers: Array<(event: AuthLoginEventPayload) => void> = []
  const sessionHandlers: Array<(payload: AuthSessionChangedPayload) => void> = []
  const loginResolvers: Array<() => void> = []
  const probeResolvers: Array<(result: AuthBackendProbeResult) => void> = []
  const api: AuthApi = {
    login: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          loginResolvers.push(resolve)
        }),
    ),
    cancelLogin: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    getSession: vi.fn(async () => snapshot),
    onLoginEvent: (handler) => {
      loginHandlers.push(handler)
      return () => {}
    },
    onSessionChanged: (handler) => {
      sessionHandlers.push(handler)
      return () => {}
    },
    openVerificationPage: vi.fn(async () => ({ ok: true }) as AuthOpenVerificationPageResult),
    probeBackend: vi.fn(
      () =>
        new Promise<AuthBackendProbeResult>((resolve) => {
          probeResolvers.push(resolve)
        }),
    ),
  }
  return {
    api,
    login: api.login as unknown as Mock,
    cancelLogin: api.cancelLogin as unknown as Mock,
    logout: api.logout as unknown as Mock,
    openVerificationPage: api.openVerificationPage as unknown as Mock,
    probeBackend: api.probeBackend as unknown as Mock,
    emitLogin: (event) => {
      for (const handler of [...loginHandlers]) handler(event)
    },
    emitSessionChanged: (payload) => {
      for (const handler of [...sessionHandlers]) handler(payload)
    },
    setSnapshot: (next) => {
      snapshot = next
    },
    resolveLogin: () => loginResolvers.splice(0).forEach((resolve) => resolve()),
    resolveProbe: (result) => probeResolvers.splice(0).forEach((resolve) => resolve(result)),
  }
}

async function renderModal(auth: AuthApi): Promise<void> {
  window.aiOfficeAuth = auth
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(SettingsModal, {
          status: null,
          loggingOut: false,
          loginWaiting: false,
          loginUrl: null,
          urlCopied: false,
          onOpenLoginUrl: vi.fn(),
          onCopyLoginUrl: vi.fn(),
          onClose: vi.fn(),
          onLogin: vi.fn(),
          onLogout: vi.fn(),
        } satisfies SettingsModalProps),
      ),
    )
    await Promise.resolve()
  })
  await flush()
}

const anonymous: AuthSessionSnapshot = { status: 'anonymous', storage: 'encrypted' }

describe('Settings → Account → cloud account', () => {
  it('runs the device flow: verbatim code, countdown, open-page and cancel actions', async () => {
    const h = makeAuth(anonymous)
    await renderModal(h.api)

    await click(buttonWithText('Sign in to cloud account'))
    expect(h.login).toHaveBeenCalledTimes(1)
    // pending: the login action is replaced by the starting state + cancel
    expect(buttonWithText('Sign in to cloud account')).toBeUndefined()
    expect(host.textContent).toContain('Contacting the sign-in server…')

    await act(async () => {
      h.emitLogin({
        status: 'waiting-for-confirmation',
        userCode: 'gZk4-9uQx',
        expiresAt: Date.now() + 600_000,
      })
    })
    await flush()
    // displayed exactly as received — no reformatting
    expect(host.querySelector('.set-cloud-code')?.textContent).toBe('gZk4-9uQx')
    expect(host.textContent).toMatch(/Code valid for \d{2}:\d{2}/)

    await click(buttonWithText('Open verification page'))
    expect(h.openVerificationPage).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('No sign-in in progress')

    await click(buttonWithText('Cancel sign-in'))
    expect(h.cancelLogin).toHaveBeenCalledTimes(1)
    await act(async () => {
      h.emitLogin({ status: 'failure', error: 'cancelled' })
      h.resolveLogin()
    })
    await flush()
    expect(host.textContent).toContain('Sign-in cancelled')

    await click(buttonWithText('Retry'))
    expect(h.login).toHaveBeenCalledTimes(2)
  })

  it('never offers a second login invoke while an attempt is pending', async () => {
    const h = makeAuth(anonymous)
    await renderModal(h.api)

    await click(buttonWithText('Sign in to cloud account'))
    expect(h.login).toHaveBeenCalledTimes(1)
    // while starting (invoke in flight, no event yet) the action is gone
    expect(buttonWithText('Sign in to cloud account')).toBeUndefined()

    // …and it stays gone through the waiting state (also the pane-reopened
    // mid-attempt case, where the pending event is replayed on subscribe)
    await act(async () => {
      h.emitLogin({
        status: 'waiting-for-confirmation',
        userCode: 'ABCD-EFGH',
        expiresAt: Date.now() + 600_000,
      })
    })
    await flush()
    expect(buttonWithText('Sign in to cloud account')).toBeUndefined()
    expect(buttonWithText('Retry')).toBeUndefined()
    expect(h.login).toHaveBeenCalledTimes(1)
  })

  it('shows the typed error when no login is in flight for the open-page action', async () => {
    const h = makeAuth(anonymous)
    h.openVerificationPage.mockResolvedValue({ ok: false, error: 'no-login-in-flight' })
    await renderModal(h.api)

    await click(buttonWithText('Sign in to cloud account'))
    await act(async () => {
      h.emitLogin({
        status: 'waiting-for-confirmation',
        userCode: 'ABCD-EFGH',
        expiresAt: Date.now() + 600_000,
      })
    })
    await flush()

    await click(buttonWithText('Open verification page'))
    expect(host.textContent).toContain('No sign-in in progress; start again')
  })

  it('shows the profile with the plain-file storage warning and signs out', async () => {
    const h = makeAuth({
      status: 'authenticated',
      storage: 'plain-file',
      profile: { sub: 'user-1', name: 'Alice', email: 'alice@example.test', roles: ['admin'] },
    })
    await renderModal(h.api)

    expect(host.textContent).toContain('Encrypted storage is unavailable on this device')
    expect(host.querySelector('.set-cloud-warning')).toBeTruthy()
    expect(host.textContent).toContain('Alice')
    expect(host.textContent).toContain('alice@example.test')
    expect(buttonWithText('Sign in to cloud account')).toBeUndefined()

    await click(buttonWithText('Sign out'))
    expect(h.logout).toHaveBeenCalledTimes(1)
    h.setSnapshot(anonymous)
    await act(async () => {
      h.emitSessionChanged({ status: 'anonymous' })
    })
    await flush()
    expect(host.textContent).not.toContain('alice@example.test')
    expect(buttonWithText('Sign in to cloud account')).toBeTruthy()
  })

  it('maps failure error codes to human messages, unknown codes to the generic line', async () => {
    const h = makeAuth(anonymous)
    await renderModal(h.api)

    await click(buttonWithText('Sign in to cloud account'))
    await act(async () => {
      h.emitLogin({ status: 'failure', error: 'access_denied' })
      h.resolveLogin()
    })
    await flush()
    expect(host.textContent).toContain('The sign-in request was denied')

    await click(buttonWithText('Retry'))
    await act(async () => {
      h.emitLogin({ status: 'failure', error: 'something_new' })
      h.resolveLogin()
    })
    await flush()
    expect(host.textContent).toContain('Sign-in failed; please try again')
  })

  it('renders nothing without the auth bridge', async () => {
    window.aiOfficeAuth = undefined
    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(SettingsModal, {
            status: null,
            loggingOut: false,
            loginWaiting: false,
            loginUrl: null,
            urlCopied: false,
            onOpenLoginUrl: vi.fn(),
            onCopyLoginUrl: vi.fn(),
            onClose: vi.fn(),
            onLogin: vi.fn(),
            onLogout: vi.fn(),
          } satisfies SettingsModalProps),
        ),
      )
      await Promise.resolve()
    })
    await flush()
    expect(host.querySelector('.set-cloud')).toBeNull()
  })
})

describe('Settings → Account → backend connection line', () => {
  const authenticated: AuthSessionSnapshot = {
    status: 'authenticated',
    storage: 'encrypted',
    profile: { sub: 'user-1', name: 'Alice', roles: [] },
  }

  it('probes once on mount when signed in, then shows connected', async () => {
    const h = makeAuth(authenticated)
    await renderModal(h.api)

    expect(h.probeBackend).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Checking connection…')

    await act(async () => {
      h.resolveProbe({ ok: true, status: 200 })
    })
    await flush()
    expect(host.textContent).toContain('Cloud service')
    expect(host.textContent).toContain('Connected')
  })

  it('shows the HTTP status when the backend answered with a non-2xx', async () => {
    const h = makeAuth(authenticated)
    await renderModal(h.api)

    await act(async () => {
      h.resolveProbe({ ok: false, status: 401 })
    })
    await flush()
    expect(host.textContent).toContain('Not connected (HTTP 401)')
  })

  it('shows plain not connected when nothing answered (network / logged out)', async () => {
    const h = makeAuth(authenticated)
    await renderModal(h.api)

    await act(async () => {
      h.resolveProbe({ ok: false })
    })
    await flush()
    expect(host.textContent).toContain('Not connected')
    expect(host.textContent).not.toContain('Not connected (HTTP')
  })

  it('re-probes only on the manual retry action — never on a timer', async () => {
    const h = makeAuth(authenticated)
    await renderModal(h.api)
    await act(async () => {
      h.resolveProbe({ ok: false, status: 503 })
    })
    await flush()

    // settling alone triggers nothing further (no poller)
    await flush()
    await flush()
    expect(h.probeBackend).toHaveBeenCalledTimes(1)

    await click(buttonWithText('Check again'))
    expect(h.probeBackend).toHaveBeenCalledTimes(2)
    await act(async () => {
      h.resolveProbe({ ok: true, status: 200 })
    })
    await flush()
    expect(host.textContent).toContain('Connected')
  })

  it('does not probe while signed out', async () => {
    const h = makeAuth(anonymous)
    await renderModal(h.api)
    await flush()

    expect(h.probeBackend).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Cloud service')
  })

  it('probes again when a session appears (sign-in completes)', async () => {
    const h = makeAuth(anonymous)
    await renderModal(h.api)

    await click(buttonWithText('Sign in to cloud account'))
    await act(async () => {
      h.emitLogin({ status: 'success' })
      h.setSnapshot(authenticated)
      h.emitSessionChanged({ status: 'authenticated' })
      h.resolveLogin()
    })
    await flush()

    expect(h.probeBackend).toHaveBeenCalledTimes(1)
    await act(async () => {
      h.resolveProbe({ ok: true, status: 200 })
    })
    await flush()
    expect(host.textContent).toContain('Connected')
  })
})
