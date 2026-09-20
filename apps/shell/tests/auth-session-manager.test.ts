import { describe, expect, it, vi } from 'vitest'

import type { FetchLike, StoredTokenSet, TokenStore } from '@genoffice/auth'
import type { AuthLoginEventPayload, AuthSessionChangedPayload } from '../src/shared/auth-api'
import { AuthSessionManager } from '../src/main/auth/session-manager'

// ── scripted issuer (same shape as the @genoffice/auth orchestrator tests) ──

const ISSUER = 'http://localhost:8080/realms/genoffice'
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
const DEVICE_ENDPOINT = `${ISSUER}/protocol/openid-connect/auth/device`
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`
const REVOKE_ENDPOINT = `${ISSUER}/protocol/openid-connect/revoke`
const END_SESSION_ENDPOINT = `${ISSUER}/protocol/openid-connect/logout`
const VERIFICATION_URI = `${ISSUER}/device`
const VERIFICATION_URI_COMPLETE = `${VERIFICATION_URI}?user_code=ABCD-EFGH`
const CLIENT_ID = 'genoffice-desktop'
const START_AT = 1_000_000

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function idToken(claims: Record<string, unknown> = {}): string {
  return [
    b64url({ alg: 'RS256', typ: 'JWT' }),
    b64url({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'user-1',
      exp: 4_102_444_800,
      name: 'Alice',
      email: 'alice@example.test',
      realm_access: { roles: ['default-roles-genoffice', 'admin'] },
      ...claims,
    }),
    b64url({ sig: true }),
  ].join('.')
}

const ID_TOKEN_1 = idToken()
const ID_TOKEN_2 = idToken({ exp: 4_102_444_900 })

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

const discovery = () =>
  jsonResponse(
    JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
      token_endpoint: TOKEN_ENDPOINT,
      device_authorization_endpoint: DEVICE_ENDPOINT,
      revocation_endpoint: REVOKE_ENDPOINT,
      end_session_endpoint: END_SESSION_ENDPOINT,
    }),
  )

const deviceAuth = () =>
  jsonResponse(
    JSON.stringify({
      device_code: 'device-code-1',
      user_code: 'ABCD-EFGH',
      verification_uri: VERIFICATION_URI,
      verification_uri_complete: VERIFICATION_URI_COMPLETE,
      expires_in: 600,
      interval: 5,
    }),
  )

function tokenSuccess(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse(
    JSON.stringify({
      access_token: 'access-1',
      token_type: 'Bearer',
      expires_in: 300,
      refresh_token: 'refresh-1',
      id_token: ID_TOKEN_1,
      ...overrides,
    }),
  )
}

const authorizationPending = () =>
  jsonResponse(JSON.stringify({ error: 'authorization_pending' }), 400)
const invalidGrant = () => jsonResponse(JSON.stringify({ error: 'invalid_grant' }), 400)

/** Route-scripted fetch: per-URL handler factories build a fresh Response per call. */
function issuerFetch(handlers: Record<string, () => Response>): FetchLike & { calls: string[] } {
  const calls: string[] = []
  const fn = (async (url: string) => {
    calls.push(url)
    const handler = handlers[url]
    if (!handler) throw new Error(`unexpected fetch: ${url}`)
    return handler()
  }) as FetchLike & { calls: string[] }
  fn.calls = calls
  return fn
}

function memoryStore(
  initial: StoredTokenSet | null = null,
): TokenStore & { peek(): StoredTokenSet | null } {
  let saved = initial
  return {
    async load() {
      return saved
    },
    async save(tokenSet) {
      saved = { ...tokenSet }
    },
    async clear() {
      saved = null
    },
    peek: () => saved,
  }
}

interface Harness {
  manager: AuthSessionManager
  opened: string[]
  loginEvents: AuthLoginEventPayload[]
  sessionEvents: AuthSessionChangedPayload[]
}

function makeHarness(options: {
  fetchFn: FetchLike
  store?: TokenStore & { peek(): StoredTokenSet | null }
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Harness {
  const opened: string[] = []
  const loginEvents: AuthLoginEventPayload[] = []
  const sessionEvents: AuthSessionChangedPayload[] = []
  const manager = new AuthSessionManager({
    config: { issuer: ISSUER, clientId: CLIENT_ID },
    store: options.store ?? memoryStore(),
    storageKind: () => 'encrypted',
    openExternal: (url) => opened.push(url),
    now: options.now,
    fetchFn: options.fetchFn,
    sleep: options.sleep,
  })
  manager.onLoginEvent((payload) => loginEvents.push(payload))
  manager.onSessionChanged((payload) => sessionEvents.push(payload))
  return { manager, opened, loginEvents, sessionEvents }
}

const instantSleep = async (): Promise<void> => {}

describe('AuthSessionManager login lifecycle', () => {
  it('streams waiting → success, opens the verification page, and never leaks URLs', async () => {
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [DEVICE_ENDPOINT]: deviceAuth,
      [TOKEN_ENDPOINT]: tokenSuccess,
      [REVOKE_ENDPOINT]: () => jsonResponse('{}'),
    })
    const harness = makeHarness({ fetchFn, sleep: instantSleep, now: () => START_AT })

    await harness.manager.startLogin()

    // the auto-open happens on the issuer origin only (flow step 3)
    expect(harness.opened).toEqual([VERIFICATION_URI_COMPLETE])
    // progress carries ONLY status/userCode/expiresAt — no URI, no token
    expect(harness.loginEvents).toEqual([
      { status: 'waiting-for-confirmation', userCode: 'ABCD-EFGH', expiresAt: START_AT + 600_000 },
      { status: 'success' },
    ])
    expect(JSON.stringify(harness.loginEvents)).not.toContain('http')
    expect(harness.sessionEvents).toEqual([{ status: 'authenticated' }])

    const snapshot = harness.manager.snapshot()
    expect(snapshot.status).toBe('authenticated')
    expect(snapshot.storage).toBe('encrypted')
    expect(snapshot.profile).toEqual({
      sub: 'user-1',
      name: 'Alice',
      email: 'alice@example.test',
      roles: ['default-roles-genoffice', 'admin'],
    })
  })

  it('replays the pending waiting event to joiners, who await the same terminal', async () => {
    const sleepResolvers: Array<() => void> = []
    const gatedSleep = (): Promise<void> =>
      new Promise((resolve) => {
        sleepResolvers.push(resolve)
      })
    const releaseSleeps = (): void => {
      sleepResolvers.splice(0).forEach((resolve) => resolve())
    }
    let deviceApproved = false
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [DEVICE_ENDPOINT]: deviceAuth,
      [TOKEN_ENDPOINT]: () => (deviceApproved ? tokenSuccess() : authorizationPending()),
    })
    const harness = makeHarness({ fetchFn, sleep: gatedSleep, now: () => START_AT })

    const first = harness.manager.startLogin()
    await vi.waitFor(() => expect(harness.loginEvents[0]?.status).toBe('waiting-for-confirmation'))

    // a second party joins mid-attempt (the ipc `auth:login` join path:
    // subscribe first, then call startLogin)
    const joinerEvents: AuthLoginEventPayload[] = []
    harness.manager.onLoginEvent((payload) => joinerEvents.push(payload))
    const joined = harness.manager.startLogin()

    // the joiner immediately recovers the user code it must display…
    expect(joinerEvents).toEqual([
      { status: 'waiting-for-confirmation', userCode: 'ABCD-EFGH', expiresAt: START_AT + 600_000 },
    ])
    // …without starting a second device flow
    expect(fetchFn.calls.filter((url) => url === DEVICE_ENDPOINT)).toHaveLength(1)

    deviceApproved = true
    releaseSleeps()
    await Promise.all([first, joined])

    expect(joinerEvents.at(-1)).toEqual({ status: 'success' })
    expect(harness.loginEvents).toEqual([
      { status: 'waiting-for-confirmation', userCode: 'ABCD-EFGH', expiresAt: START_AT + 600_000 },
      { status: 'success' },
    ])
  })

  it('refuses to open a verification URL outside the issuer origin', async () => {
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [DEVICE_ENDPOINT]: () =>
        jsonResponse(
          JSON.stringify({
            device_code: 'device-code-1',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://evil.example/device',
            verification_uri_complete: 'https://evil.example/device?user_code=ABCD-EFGH',
            expires_in: 600,
            interval: 5,
          }),
        ),
      [TOKEN_ENDPOINT]: tokenSuccess,
    })
    const harness = makeHarness({ fetchFn, sleep: instantSleep })

    await harness.manager.startLogin()

    expect(harness.opened).toEqual([]) // gate dropped the foreign origin
    expect(harness.loginEvents[0]).toMatchObject({ status: 'waiting-for-confirmation' })
  })

  it('reports poll failures as stable codes with no endpoint URLs', async () => {
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [DEVICE_ENDPOINT]: deviceAuth,
      [TOKEN_ENDPOINT]: () => jsonResponse(JSON.stringify({ error: 'access_denied' }), 400),
    })
    const harness = makeHarness({ fetchFn, sleep: instantSleep })

    await harness.manager.startLogin()

    expect(harness.loginEvents).toHaveLength(2)
    expect(harness.loginEvents[1]).toEqual({ status: 'failure', error: 'access_denied' })
    expect(JSON.stringify(harness.loginEvents[1])).not.toContain('http')
    expect(harness.sessionEvents).toEqual([]) // never authenticated
    expect(harness.manager.snapshot().status).toBe('anonymous')
  })

  it('emits failure/cancelled when the in-flight login is cancelled', async () => {
    let releaseSleep: (() => void) | undefined
    const gatedSleep = (): Promise<void> =>
      new Promise((resolve) => {
        releaseSleep = resolve
      })
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [DEVICE_ENDPOINT]: deviceAuth,
      [TOKEN_ENDPOINT]: authorizationPending,
    })
    const harness = makeHarness({ fetchFn, sleep: gatedSleep })

    const login = harness.manager.startLogin()
    await vi.waitFor(() => expect(releaseSleep).toBeDefined())
    harness.manager.cancelLogin()
    releaseSleep?.()
    await login

    expect(harness.loginEvents.at(-1)).toEqual({ status: 'failure', error: 'cancelled' })
    expect(harness.manager.snapshot().status).toBe('anonymous')
  })
})

describe('AuthSessionManager.openVerificationPage', () => {
  it('re-opens the in-flight login’s verification URL through the same gate', async () => {
    const gatedSleep = (): Promise<void> => new Promise(() => {}) // park the poller
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [DEVICE_ENDPOINT]: deviceAuth,
      [TOKEN_ENDPOINT]: authorizationPending,
    })
    const harness = makeHarness({ fetchFn, sleep: gatedSleep, now: () => START_AT })

    const login = harness.manager.startLogin()
    await vi.waitFor(() => expect(harness.loginEvents[0]?.status).toBe('waiting-for-confirmation'))
    expect(harness.opened).toEqual([VERIFICATION_URI_COMPLETE]) // the auto-open

    expect(harness.manager.openVerificationPage()).toEqual({ ok: true })
    expect(harness.opened).toEqual([VERIFICATION_URI_COMPLETE, VERIFICATION_URI_COMPLETE])

    harness.manager.cancelLogin() // settle the parked attempt
    await login
  })

  it('returns the typed error when no login is in flight (before and after an attempt)', async () => {
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [DEVICE_ENDPOINT]: deviceAuth,
      [TOKEN_ENDPOINT]: tokenSuccess,
    })
    const harness = makeHarness({ fetchFn, sleep: instantSleep, now: () => START_AT })

    expect(harness.manager.openVerificationPage()).toEqual({
      ok: false,
      error: 'no-login-in-flight',
    })
    expect(harness.opened).toEqual([])

    await harness.manager.startLogin() // terminal event reached
    expect(harness.manager.openVerificationPage()).toEqual({
      ok: false,
      error: 'no-login-in-flight',
    })
    expect(harness.opened).toEqual([VERIFICATION_URI_COMPLETE]) // only the auto-open
  })

  it('returns the typed error once the user code expired, without opening anything', async () => {
    const gatedSleep = (): Promise<void> => new Promise(() => {}) // park the poller
    let clock = START_AT
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [DEVICE_ENDPOINT]: deviceAuth,
      [TOKEN_ENDPOINT]: authorizationPending,
    })
    const harness = makeHarness({ fetchFn, sleep: gatedSleep, now: () => clock })

    const login = harness.manager.startLogin()
    await vi.waitFor(() => expect(harness.loginEvents[0]?.status).toBe('waiting-for-confirmation'))

    // expires_in 600 → the code is dead at START_AT + 600s
    clock = START_AT + 600_001
    expect(harness.manager.openVerificationPage()).toEqual({
      ok: false,
      error: 'no-login-in-flight',
    })
    expect(harness.opened).toEqual([VERIFICATION_URI_COMPLETE]) // only the auto-open

    harness.manager.cancelLogin() // settle the parked attempt
    await login
  })

  it('drops a re-open whose verification URL left the issuer origin (same as the auto-open)', async () => {
    const gatedSleep = (): Promise<void> => new Promise(() => {}) // park the poller
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [DEVICE_ENDPOINT]: () =>
        jsonResponse(
          JSON.stringify({
            device_code: 'device-code-1',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://evil.example/device',
            verification_uri_complete: 'https://evil.example/device?user_code=ABCD-EFGH',
            expires_in: 600,
            interval: 5,
          }),
        ),
      [TOKEN_ENDPOINT]: authorizationPending,
    })
    const harness = makeHarness({ fetchFn, sleep: gatedSleep, now: () => START_AT })

    const login = harness.manager.startLogin()
    await vi.waitFor(() => expect(harness.loginEvents[0]?.status).toBe('waiting-for-confirmation'))
    expect(harness.opened).toEqual([]) // the auto-open was gated

    expect(harness.manager.openVerificationPage()).toEqual({ ok: true })
    expect(harness.opened).toEqual([]) // and so is the re-open

    harness.manager.cancelLogin() // settle the parked attempt
    await login
  })
})

describe('AuthSessionManager refresh timer', () => {
  it('refreshes at exp − 30s without broadcasting a session change', async () => {
    vi.useFakeTimers()
    try {
      let clock = START_AT
      let tokenCall = 0
      const fetchFn = issuerFetch({
        [DISCOVERY_URL]: discovery,
        [DEVICE_ENDPOINT]: deviceAuth,
        [TOKEN_ENDPOINT]: () => {
          tokenCall += 1
          return tokenCall === 1
            ? tokenSuccess()
            : tokenSuccess({
                access_token: 'access-2',
                refresh_token: 'refresh-2',
                id_token: ID_TOKEN_2,
              })
        },
        [REVOKE_ENDPOINT]: () => jsonResponse('{}'),
      })
      const harness = makeHarness({ fetchFn, sleep: instantSleep, now: () => clock })

      await harness.manager.startLogin()
      expect(harness.sessionEvents).toEqual([{ status: 'authenticated' }])
      const callsBefore = fetchFn.calls.filter((url) => url === TOKEN_ENDPOINT).length

      // expires_in 300 → timer fires at exp − 30s = 270s after obtainment
      clock += 270_000
      await vi.advanceTimersByTimeAsync(270_000)

      const refreshCalls = fetchFn.calls.filter((url) => url === TOKEN_ENDPOINT).length
      expect(refreshCalls).toBe(callsBefore + 1)
      expect(harness.manager.snapshot().status).toBe('authenticated')
      // a silent token refresh is not a renderer-visible change
      expect(harness.sessionEvents).toEqual([{ status: 'authenticated' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('wipes and broadcasts anonymous when the proactive refresh is rejected', async () => {
    vi.useFakeTimers()
    try {
      let clock = START_AT
      let tokenCall = 0
      const fetchFn = issuerFetch({
        [DISCOVERY_URL]: discovery,
        [DEVICE_ENDPOINT]: deviceAuth,
        [TOKEN_ENDPOINT]: () => {
          tokenCall += 1
          return tokenCall === 1 ? tokenSuccess() : invalidGrant()
        },
        [REVOKE_ENDPOINT]: () => jsonResponse('{}'),
      })
      const store = memoryStore()
      const harness = makeHarness({ fetchFn, store, sleep: instantSleep, now: () => clock })

      await harness.manager.startLogin()
      expect(store.peek()).not.toBeNull()

      clock += 270_000
      await vi.advanceTimersByTimeAsync(270_000)

      expect(harness.manager.snapshot().status).toBe('anonymous')
      expect(harness.sessionEvents.at(-1)).toEqual({ status: 'anonymous' })
      expect(store.peek()).toBeNull()

      // and it stays quiet: no further refresh attempts after the wipe
      const calls = fetchFn.calls.length
      clock += 600_000
      await vi.advanceTimersByTimeAsync(600_000)
      expect(fetchFn.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AuthSessionManager logout', () => {
  it('wipes, broadcasts, and opens the origin-checked end-session URL; the timer stops', async () => {
    vi.useFakeTimers()
    try {
      let clock = START_AT
      const fetchFn = issuerFetch({
        [DISCOVERY_URL]: discovery,
        [DEVICE_ENDPOINT]: deviceAuth,
        [TOKEN_ENDPOINT]: tokenSuccess,
        [REVOKE_ENDPOINT]: () => jsonResponse('{}'),
      })
      const store = memoryStore()
      const harness = makeHarness({ fetchFn, store, sleep: instantSleep, now: () => clock })

      await harness.manager.startLogin()
      await harness.manager.logout()

      expect(store.peek()).toBeNull()
      expect(harness.manager.snapshot().status).toBe('anonymous')
      expect(harness.sessionEvents.at(-1)).toEqual({ status: 'anonymous' })

      // login's verification open + logout's end-session open (with hint)
      expect(harness.opened).toHaveLength(2)
      const endSessionUrl = new URL(harness.opened[1])
      expect(endSessionUrl.origin).toBe(new URL(ISSUER).origin)
      expect(endSessionUrl.pathname).toBe('/realms/genoffice/protocol/openid-connect/logout')
      expect(endSessionUrl.searchParams.get('id_token_hint')).toBe(ID_TOKEN_1)

      // timer cleared: no refresh traffic after logout
      const calls = fetchFn.calls.length
      clock += 600_000
      await vi.advanceTimersByTimeAsync(600_000)
      expect(fetchFn.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AuthSessionManager restore', () => {
  const storedSet = (overrides: Partial<StoredTokenSet> = {}): StoredTokenSet => ({
    refreshToken: 'refresh-1',
    idToken: ID_TOKEN_1,
    profile: { sub: 'user-1', name: 'Alice' },
    obtainedAt: 999_000,
    issuer: ISSUER,
    ...overrides,
  })

  it('restores a valid stored session via the refresh grant', async () => {
    const fetchFn = issuerFetch({
      [DISCOVERY_URL]: discovery,
      [TOKEN_ENDPOINT]: () =>
        tokenSuccess({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          id_token: ID_TOKEN_2,
        }),
    })
    const store = memoryStore(storedSet())
    const harness = makeHarness({ fetchFn, store, sleep: instantSleep, now: () => START_AT })

    await harness.manager.restore()

    expect(harness.manager.snapshot().status).toBe('authenticated')
    expect(harness.sessionEvents).toEqual([{ status: 'authenticated' }])
    // the refresh grant carried the refresh token
    const refreshCall = fetchFn.calls.filter((url) => url === TOKEN_ENDPOINT).length
    expect(refreshCall).toBe(1)
  })

  it('wipes stored credentials that belong to a different issuer', async () => {
    const fetchFn = issuerFetch({})
    const store = memoryStore(storedSet({ issuer: 'https://other.example.com/realms/x' }))
    const harness = makeHarness({ fetchFn, store, sleep: instantSleep, now: () => START_AT })

    await harness.manager.restore()

    expect(store.peek()).toBeNull()
    expect(harness.manager.snapshot().status).toBe('anonymous')
    expect(fetchFn.calls).toEqual([]) // no network on a local mismatch
  })

  it('wipes stored credentials whose id token fails the iss/aud/sub checks', async () => {
    const fetchFn = issuerFetch({})
    const store = memoryStore(storedSet({ idToken: idToken({ iss: 'https://evil.example' }) }))
    const harness = makeHarness({ fetchFn, store, sleep: instantSleep, now: () => START_AT })

    await harness.manager.restore()

    expect(store.peek()).toBeNull()
    expect(harness.manager.snapshot().status).toBe('anonymous')
    expect(fetchFn.calls).toEqual([])
  })

  it('keeps the store and stays silent on transient restore failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fetchFn = issuerFetch({
        [DISCOVERY_URL]: () => {
          throw new Error('network down')
        },
      })
      const store = memoryStore(storedSet())
      const harness = makeHarness({ fetchFn, store, sleep: instantSleep, now: () => START_AT })

      await harness.manager.restore()

      expect(harness.manager.snapshot().status).toBe('anonymous')
      expect(store.peek()).not.toBeNull() // retried next launch
      expect(harness.sessionEvents).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})
