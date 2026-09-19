import { describe, expect, it, vi } from 'vitest'

import { AuthOrchestrator } from '../src/auth.js'
import { AuthFlowError, TokenPollError } from '../src/errors.js'
import type { Sleep, StoredTokenSet, TokenStore, UserProfile } from '../src/types.js'

// ────────────────────────────────────────────────────────────
// Test constants + helpers
// ────────────────────────────────────────────────────────────

const ISSUER = 'http://localhost:8080/realms/genoffice'
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
const DEVICE_ENDPOINT = `${ISSUER}/protocol/openid-connect/auth/device`
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`
const REVOKE_ENDPOINT = `${ISSUER}/protocol/openid-connect/revoke`
const END_SESSION_ENDPOINT = `${ISSUER}/protocol/openid-connect/logout`
const VERIFICATION_URI = `${ISSUER}/device`
const VERIFICATION_URI_COMPLETE = `${VERIFICATION_URI}?user_code=ABCD-EFGH`

const CLIENT_ID = 'genoffice'
const DEFAULT_SCOPE = 'openid profile email offline_access'
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const REFRESH_GRANT_TYPE = 'refresh_token'
const START_AT = 1_000_000

/** JWT whose signature segment is present but never verified (core decodes only) */
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
      preferred_username: 'alice',
      ...claims,
    }),
    b64url({ sig: true }),
  ].join('.')
}

const ID_TOKEN_1 = idToken()
const ID_TOKEN_2 = idToken({ exp: 4_102_444_900 })

const PROFILE: UserProfile = {
  sub: 'user-1',
  name: 'Alice',
  email: 'alice@example.test',
  preferredUsername: 'alice',
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function oauthError(error: string, status = 400): Response {
  return jsonResponse(JSON.stringify({ error }), status)
}

const pending = (): Response => oauthError('authorization_pending')

function tokenSuccessJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 300,
    refresh_token: 'refresh-1',
    id_token: ID_TOKEN_1,
    scope: DEFAULT_SCOPE,
    ...overrides,
  })
}

const tokenSuccess = (): Response => jsonResponse(tokenSuccessJson())
const refreshSuccess = (): Response =>
  jsonResponse(tokenSuccessJson({ access_token: 'access-2', refresh_token: 'refresh-2', id_token: ID_TOKEN_2 }))

function discoveryJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: TOKEN_ENDPOINT,
    device_authorization_endpoint: DEVICE_ENDPOINT,
    revocation_endpoint: REVOKE_ENDPOINT,
    end_session_endpoint: END_SESSION_ENDPOINT,
    ...overrides,
  })
}

function deviceAuthJson(): string {
  return JSON.stringify({
    device_code: 'device-code-1',
    user_code: 'ABCD-EFGH',
    verification_uri: VERIFICATION_URI,
    verification_uri_complete: VERIFICATION_URI_COMPLETE,
    expires_in: 600,
    interval: 5,
  })
}

/** Fetch mock serving a scripted sequence; a call past the script throws */
function queueResponses(...script: Response[]) {
  const queue = [...script]
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = queue.shift()
    if (next === undefined) throw new Error('unexpected fetch: script exhausted')
    return next
  })
}

/** Form body of a recorded fetch call, for request-shape assertions */
function bodyOf(call: unknown[]): URLSearchParams {
  const init = call[1] as RequestInit | undefined
  return new URLSearchParams(String(init?.body))
}

/** Deterministic microtask pump */
async function until(condition: () => boolean, limit = 10_000): Promise<void> {
  for (let i = 0; i < limit && !condition(); i += 1) await Promise.resolve()
  if (!condition()) throw new Error('condition not reached within the microtask budget')
}

/** Capture a rejection as a value (null when the promise resolves) */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  )
}

/** In-memory TokenStore double that records every call */
function memoryStore(initial: StoredTokenSet | null = null) {
  let current = initial
  const save = vi.fn(async (tokenSet: StoredTokenSet) => {
    current = tokenSet
  })
  const load = vi.fn(async (): Promise<StoredTokenSet | null> => current)
  const clear = vi.fn(async () => {
    current = null
  })
  const iface: TokenStore = { load, save, clear }
  return { iface, save, load, clear, current: () => current }
}

function fakeClock(startAt = START_AT): { now: () => number; advance: (ms: number) => void } {
  let t = startAt
  return { now: () => t, advance: (ms) => (t += ms) }
}

interface WorldOptions {
  /** Scripted token-endpoint responses (default: none) */
  tokenScript?: Response[]
  /** Preloaded store content (session-restore / restart cases) */
  initialStore?: StoredTokenSet | null
  /** Replacement device-authorization route (e.g. a gated promise) */
  device?: (url: string, init?: RequestInit) => Promise<Response>
  /** Fields merged into (or removed from) the discovery document */
  discoveryOverrides?: Record<string, unknown>
  /** Fixed revocation response (default 204 No Content) */
  revocation?: Response
  /** Injected sleep (default: immediate) */
  sleep?: Sleep
}

/** An orchestrator wired to a fully mocked provider: every endpoint is a spy */
function makeWorld(options: WorldOptions = {}) {
  const clock = fakeClock()
  const store = memoryStore(options.initialStore ?? null)
  const discovery = vi.fn(async (_url: string, _init?: RequestInit) =>
    jsonResponse(discoveryJson(options.discoveryOverrides)),
  )
  const device = vi.fn(
    options.device ??
      (async (_url: string, _init?: RequestInit) => jsonResponse(deviceAuthJson())),
  )
  const token = queueResponses(...(options.tokenScript ?? []))
  const revocation = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      options.revocation ?? new Response(null, { status: 204 }),
  )
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    switch (url) {
      case DISCOVERY_URL:
        return discovery(url, init)
      case DEVICE_ENDPOINT:
        return device(url, init)
      case TOKEN_ENDPOINT:
        return token(url, init)
      case REVOKE_ENDPOINT:
        return revocation(url, init)
      default:
        throw new Error(`unexpected fetch: ${url}`)
    }
  })
  const orchestrator = new AuthOrchestrator({
    config: { issuer: ISSUER, clientId: CLIENT_ID },
    store: store.iface,
    fetchFn,
    now: clock.now,
    sleep: options.sleep ?? (async () => {}),
  })
  return { orchestrator, clock, store, discovery, device, token, revocation, fetchFn }
}

const storedSet = (): StoredTokenSet => ({
  refreshToken: 'refresh-stored',
  idToken: ID_TOKEN_1,
  profile: PROFILE,
  obtainedAt: 42_000,
  issuer: ISSUER,
})

// ────────────────────────────────────────────────────────────
// startLogin — happy path (pending → approved)
// ────────────────────────────────────────────────────────────

describe('AuthOrchestrator.startLogin happy path', () => {
  it('walks discovery → device-auth → poll → id-token validation → store', async () => {
    const w = makeWorld({ tokenScript: [pending(), tokenSuccess()] })

    const handle = await w.orchestrator.startLogin()

    // Display info for the UI (user code shown verbatim, main-process URLs)
    expect(handle.userCode).toBe('ABCD-EFGH')
    expect(handle.verificationUri).toBe(VERIFICATION_URI)
    expect(handle.verificationUriComplete).toBe(VERIFICATION_URI_COMPLETE)
    expect(handle.expiresAt).toBe(START_AT + 600_000)

    const session = await handle.tokens
    expect(session.accessToken).toBe('access-1')
    expect(session.idToken).toBe(ID_TOKEN_1)
    expect(session.profile).toEqual(PROFILE)
    expect(session.obtainedAt).toBe(START_AT)
    expect(session.accessTokenExpiresAt).toBe(START_AT + 300_000)

    // Discovery + device request shapes
    expect(w.discovery).toHaveBeenCalledTimes(1)
    expect(w.device.mock.calls[0][0]).toBe(DEVICE_ENDPOINT)
    const deviceInit = w.device.mock.calls[0][1]
    expect(deviceInit?.method).toBe('POST')
    expect(new Headers(deviceInit?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(bodyOf(w.device.mock.calls[0]).get('client_id')).toBe(CLIENT_ID)
    expect(bodyOf(w.device.mock.calls[0]).get('scope')).toBe(DEFAULT_SCOPE)

    // Poll request shape: device grant with the device_code
    expect(w.token.mock.calls[0][0]).toBe(TOKEN_ENDPOINT)
    const pollBody = bodyOf(w.token.mock.calls[0])
    expect(pollBody.get('grant_type')).toBe(DEVICE_GRANT_TYPE)
    expect(pollBody.get('device_code')).toBe('device-code-1')
    expect(pollBody.get('client_id')).toBe(CLIENT_ID)
    // pending → approved is exactly two polls
    expect(w.token).toHaveBeenCalledTimes(2)

    // Persisted set: refresh + id + profile + metadata — no access token
    expect(w.store.save).toHaveBeenCalledTimes(1)
    expect(w.store.current()).toEqual({
      refreshToken: 'refresh-1',
      idToken: ID_TOKEN_1,
      profile: PROFILE,
      obtainedAt: START_AT,
      issuer: ISSUER,
    })
  })

  it('rejects with missing_endpoint when discovery advertises no device endpoint', async () => {
    const w = makeWorld({
      tokenScript: [tokenSuccess()],
      discoveryOverrides: { device_authorization_endpoint: undefined },
    })

    const err = await rejectionOf(w.orchestrator.startLogin())
    expect(err).toBeInstanceOf(AuthFlowError)
    expect((err as AuthFlowError).code).toBe('missing_endpoint')
    expect(w.device).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────
// startLogin — single-flight
// ────────────────────────────────────────────────────────────

describe('AuthOrchestrator.startLogin single-flight', () => {
  it('joins an in-flight attempt: same handle, one device-auth request', async () => {
    const w = makeWorld({ tokenScript: [pending(), tokenSuccess()] })

    const [first, second] = await Promise.all([
      w.orchestrator.startLogin(),
      w.orchestrator.startLogin(),
    ])

    // Join, not a second attempt: the identical handle object comes back
    expect(second).toBe(first)
    await expect(first.tokens).resolves.toMatchObject({ accessToken: 'access-1' })
    expect(w.device).toHaveBeenCalledTimes(1)
    expect(w.token).toHaveBeenCalledTimes(2)
    expect(w.store.save).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh login after the previous attempt failed', async () => {
    const w = makeWorld({ tokenScript: [oauthError('access_denied'), tokenSuccess()] })

    const failed = await w.orchestrator.startLogin()
    await rejectionOf(failed.tokens)

    const retry = await w.orchestrator.startLogin()
    await expect(retry.tokens).resolves.toMatchObject({ accessToken: 'access-1' })
    expect(w.device).toHaveBeenCalledTimes(2)
  })
})

// ────────────────────────────────────────────────────────────
// startLogin — terminal conditions
// ────────────────────────────────────────────────────────────

describe('AuthOrchestrator.startLogin terminal conditions', () => {
  it('surfaces user denial as a typed error and never touches the store', async () => {
    const w = makeWorld({ tokenScript: [oauthError('access_denied')] })

    const handle = await w.orchestrator.startLogin()
    const err = await rejectionOf(handle.tokens)

    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('access_denied')
    expect(w.store.save).not.toHaveBeenCalled()
    // No secret reaches the error surface
    expect((err as TokenPollError).message).not.toContain('device-code-1')
    expect((err as TokenPollError).message).not.toContain('refresh-1')
  })

  it('surfaces device-code expiry as a typed error', async () => {
    const w = makeWorld({ tokenScript: [oauthError('expired_token')] })

    const handle = await w.orchestrator.startLogin()
    const err = await rejectionOf(handle.tokens)

    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('expired_token')
    expect(w.store.save).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────
// cancelLogin
// ────────────────────────────────────────────────────────────

describe('AuthOrchestrator.cancelLogin', () => {
  it('cancels mid-poll: tokens reject with cancelled, nothing is stored', async () => {
    const w = makeWorld({
      tokenScript: [pending(), tokenSuccess()],
      // A sleep that never resolves parks the poll loop after the first poll
      sleep: () => new Promise<void>(() => {}),
    })

    const handle = await w.orchestrator.startLogin()
    handle.cancel()

    const err = await rejectionOf(handle.tokens)
    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('cancelled')
    expect(w.token).toHaveBeenCalledTimes(1)
    expect(w.store.save).not.toHaveBeenCalled()
  })

  it('cancels before the device-auth response arrives: the handle itself rejects', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let deviceAnswered = false
    const w = makeWorld({
      tokenScript: [tokenSuccess()],
      device: async () => {
        await gate
        deviceAnswered = true
        return jsonResponse(deviceAuthJson())
      },
    })

    const handlePromise = w.orchestrator.startLogin()
    // Wait until the device request is in flight (discovery already resolved)
    await until(() => w.device.mock.calls.length === 1)
    w.orchestrator.cancelLogin()

    const err = await rejectionOf(handlePromise)
    expect(err).toBeInstanceOf(AuthFlowError)
    expect((err as AuthFlowError).code).toBe('cancelled')

    // The late device response must not start a poll or settle anything
    release()
    await until(() => deviceAnswered)
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(w.token).not.toHaveBeenCalled()
    expect(w.store.save).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────
// refresh
// ────────────────────────────────────────────────────────────

describe('AuthOrchestrator.refresh', () => {
  it('refreshes via the refresh_token grant and rotates the stored credentials', async () => {
    const w = makeWorld({ tokenScript: [pending(), tokenSuccess(), refreshSuccess()] })
    await (await w.orchestrator.startLogin()).tokens

    const session = await w.orchestrator.refresh()

    // Request shape
    expect(w.token).toHaveBeenCalledTimes(3)
    expect(w.token.mock.calls[2][0]).toBe(TOKEN_ENDPOINT)
    const body = bodyOf(w.token.mock.calls[2])
    expect(body.get('grant_type')).toBe(REFRESH_GRANT_TYPE)
    expect(body.get('refresh_token')).toBe('refresh-1')
    expect(body.get('client_id')).toBe(CLIENT_ID)

    // New session + rotated persisted set
    expect(session.accessToken).toBe('access-2')
    expect(session.idToken).toBe(ID_TOKEN_2)
    expect(session.accessTokenExpiresAt).toBe(START_AT + 300_000)
    expect(w.store.current()).toMatchObject({ refreshToken: 'refresh-2', idToken: ID_TOKEN_2 })
  })

  it('restores from the store when there is no in-memory session (restart path)', async () => {
    const w = makeWorld({ tokenScript: [refreshSuccess()], initialStore: storedSet() })

    const session = await w.orchestrator.refresh()

    expect(bodyOf(w.token.mock.calls[0]).get('refresh_token')).toBe('refresh-stored')
    expect(session.accessToken).toBe('access-2')
    expect(w.store.current()).toMatchObject({ refreshToken: 'refresh-2' })
  })

  it('surfaces an expired/rejected refresh token as a typed error, store untouched', async () => {
    const w = makeWorld({
      tokenScript: [
        pending(),
        tokenSuccess(),
        jsonResponse(JSON.stringify({ error: 'invalid_grant', error_description: 'Token is not active' }), 400),
      ],
    })
    await (await w.orchestrator.startLogin()).tokens

    const err = await rejectionOf(w.orchestrator.refresh())

    expect(err).toBeInstanceOf(AuthFlowError)
    expect((err as AuthFlowError).code).toBe('refresh_failed')
    expect((err as AuthFlowError).status).toBe(400)
    // The refresh token never reaches the error surface
    expect((err as AuthFlowError).message).not.toContain('refresh-1')
    // The pre-refresh stored set is left as it was
    expect(w.store.save).toHaveBeenCalledTimes(1)
    expect(w.store.current()).toMatchObject({ refreshToken: 'refresh-1' })
  })

  it('throws not_logged_in with no session and empty store, hitting no endpoint', async () => {
    const w = makeWorld({ tokenScript: [] })

    const err = await rejectionOf(w.orchestrator.refresh())

    expect(err).toBeInstanceOf(AuthFlowError)
    expect((err as AuthFlowError).code).toBe('not_logged_in')
    expect(w.token).not.toHaveBeenCalled()
    expect(w.discovery).not.toHaveBeenCalled()
  })

  it('is single-flight: concurrent calls share one token request', async () => {
    const w = makeWorld({ tokenScript: [pending(), tokenSuccess(), refreshSuccess()] })
    await (await w.orchestrator.startLogin()).tokens

    const first = w.orchestrator.refresh()
    const second = w.orchestrator.refresh()

    // Join: the very same promise object, and only one refresh request
    expect(second).toBe(first)
    const sessions = await Promise.all([first, second])
    expect(sessions[0]).toBe(sessions[1])
    expect(w.token).toHaveBeenCalledTimes(3)
  })
})

// ────────────────────────────────────────────────────────────
// logout
// ────────────────────────────────────────────────────────────

describe('AuthOrchestrator.logout', () => {
  it('revokes the refresh token, wipes the store, and returns the end-session URL', async () => {
    const w = makeWorld({ tokenScript: [pending(), tokenSuccess()] })
    await (await w.orchestrator.startLogin()).tokens

    const result = await w.orchestrator.logout()

    // Revocation request shape
    expect(w.revocation).toHaveBeenCalledTimes(1)
    expect(w.revocation.mock.calls[0][0]).toBe(REVOKE_ENDPOINT)
    const revokeInit = w.revocation.mock.calls[0][1]
    expect(revokeInit?.method).toBe('POST')
    expect(new Headers(revokeInit?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    const revokeBody = bodyOf(w.revocation.mock.calls[0])
    expect(revokeBody.get('token')).toBe('refresh-1')
    expect(revokeBody.get('token_type_hint')).toBe('refresh_token')
    expect(revokeBody.get('client_id')).toBe(CLIENT_ID)

    // Local wipe is guaranteed
    expect(w.store.clear).toHaveBeenCalledTimes(1)
    expect(w.store.current()).toBeNull()

    // End-session URL constructed with the id_token_hint, nothing opened here
    expect(result.endSessionUrl).toBe(`${END_SESSION_ENDPOINT}?id_token_hint=${encodeURIComponent(ID_TOKEN_1)}`)

    // Memory wiped too: nothing left to refresh with
    const err = await rejectionOf(w.orchestrator.refresh())
    expect((err as AuthFlowError).code).toBe('not_logged_in')
  })

  it('still clears the store and returns the URL when revocation answers 500', async () => {
    const w = makeWorld({
      tokenScript: [pending(), tokenSuccess()],
      revocation: jsonResponse(JSON.stringify({ error: 'server_error' }), 500),
    })
    await (await w.orchestrator.startLogin()).tokens

    const result = await w.orchestrator.logout()

    expect(w.revocation).toHaveBeenCalledTimes(1)
    expect(w.store.clear).toHaveBeenCalledTimes(1)
    expect(w.store.current()).toBeNull()
    expect(result.endSessionUrl).toBe(`${END_SESSION_ENDPOINT}?id_token_hint=${encodeURIComponent(ID_TOKEN_1)}`)
  })

  it('revokes the stored refresh token after a restart (no in-memory session)', async () => {
    const w = makeWorld({ initialStore: storedSet() })

    const result = await w.orchestrator.logout()

    expect(bodyOf(w.revocation.mock.calls[0]).get('token')).toBe('refresh-stored')
    expect(result.endSessionUrl).toBe(`${END_SESSION_ENDPOINT}?id_token_hint=${encodeURIComponent(ID_TOKEN_1)}`)
    expect(w.store.clear).toHaveBeenCalledTimes(1)
  })

  it('is a clean no-op wipe when there is nothing to log out', async () => {
    const w = makeWorld({ tokenScript: [] })

    const result = await w.orchestrator.logout()

    expect(result.endSessionUrl).toBeUndefined()
    expect(w.store.clear).toHaveBeenCalledTimes(1)
    expect(w.revocation).not.toHaveBeenCalled()
    expect(w.discovery).not.toHaveBeenCalled()
  })
})
