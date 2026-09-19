import { describe, expect, it, vi } from 'vitest'
import { startDeviceTokenPoll } from '../src/token-poller.js'
import { TokenPollError, TokenSetError } from '../src/errors.js'

// ────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────

const TOKEN_ENDPOINT = 'http://localhost:8080/realms/genoffice/protocol/openid-connect/token'
const CLIENT_ID = 'genoffice'
const DEVICE_CODE = 'device-code-1'
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function oauthError(error: string, status = 400): Response {
  return jsonResponse(JSON.stringify({ error }), status)
}

const pending = (): Response => oauthError('authorization_pending')
const slowDown = (): Response => oauthError('slow_down')

function tokenSuccess(): Response {
  return jsonResponse(
    JSON.stringify({
      access_token: 'access-1',
      token_type: 'Bearer',
      expires_in: 300,
      refresh_token: 'refresh-1',
      id_token: 'id-1',
      scope: 'openid profile offline_access',
    }),
  )
}

/** Fetch mock serving a scripted sequence; a call past the script throws (surfaces as over-polling) */
function queueResponses(...script: Response[]) {
  const queue = [...script]
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = queue.shift()
    if (next === undefined) throw new Error('unexpected fetch: script exhausted')
    return next
  })
}

function fakeClock(startAt = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = startAt
  return { now: () => t, advance: (ms) => (t += ms) }
}

/** Sleep spy that advances the fake clock by the slept amount, mimicking real time */
function clockAdvancingSleep(clock: { advance: (ms: number) => void }) {
  return vi.fn(async (ms: number) => {
    clock.advance(ms)
  })
}

/** Deterministic microtask pump: lets the poll loop progress without any real timer */
async function until(condition: () => boolean, limit = 10_000): Promise<void> {
  for (let i = 0; i < limit && !condition(); i += 1) await Promise.resolve()
  if (!condition()) throw new Error('condition not reached within the microtask budget')
}

function baseOptions(overrides: Partial<Parameters<typeof startDeviceTokenPoll>[0]> = {}) {
  return {
    endpoint: TOKEN_ENDPOINT,
    clientId: CLIENT_ID,
    deviceCode: DEVICE_CODE,
    expiresIn: 600,
    interval: 5,
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────

describe('startDeviceTokenPoll happy path', () => {
  it('polls pending → pending → approved, resolves with the parsed token set', async () => {
    const fetchFn = queueResponses(pending(), pending(), tokenSuccess())
    const sleep = vi.fn(async (_ms: number) => {})

    const handle = startDeviceTokenPoll({ ...baseOptions(), interval: 7, fetchFn, sleep })
    const tokenSet = await handle.promise

    // Poll count and cadence: three polls, two sleeps of exactly the 7 s interval
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([7_000, 7_000])

    // Resolved token set (parsed by the token-set module)
    expect(tokenSet.accessToken).toBe('access-1')
    expect(tokenSet.refreshToken).toBe('refresh-1')
    expect(tokenSet.idToken).toBe('id-1')
    expect(tokenSet.expiresIn).toBe(300)

    // Request shape: device grant, device_code + client_id as a form body
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(TOKEN_ENDPOINT)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(String(init?.body))
    expect(body.get('grant_type')).toBe(DEVICE_GRANT_TYPE)
    expect(body.get('device_code')).toBe(DEVICE_CODE)
    expect(body.get('client_id')).toBe(CLIENT_ID)

    // cancel() after settlement is a harmless no-op
    handle.cancel()
    await expect(handle.promise).resolves.toMatchObject({ accessToken: 'access-1' })
  })
})

// ────────────────────────────────────────────────────────────
// slow_down (RFC 8628 §3.5)
// ────────────────────────────────────────────────────────────

describe('startDeviceTokenPoll slow_down', () => {
  it('lengthens the interval by 5 s over the current interval and keeps the increased cadence', async () => {
    const fetchFn = queueResponses(slowDown(), slowDown(), tokenSuccess())
    const sleep = vi.fn(async (_ms: number) => {})

    const handle = startDeviceTokenPoll({ ...baseOptions(), fetchFn, sleep })
    await handle.promise

    // 5 s → 10 s → 15 s, each increase persisting
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([10_000, 15_000])
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })
})

// ────────────────────────────────────────────────────────────
// Terminal errors
// ────────────────────────────────────────────────────────────

describe('startDeviceTokenPoll terminal errors', () => {
  it('rejects with TokenPollError (access_denied) and stops polling', async () => {
    const fetchFn = queueResponses(oauthError('access_denied'))
    const sleep = vi.fn(async (_ms: number) => {})

    const handle = startDeviceTokenPoll({ ...baseOptions(), fetchFn, sleep })
    const err = await handle.promise.then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('access_denied')
    expect((err as TokenPollError).status).toBe(400)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    // The device_code never reaches the error surface
    expect((err as TokenPollError).message).not.toContain(DEVICE_CODE)
  })

  it('rejects with TokenPollError (expired_token) and stops polling', async () => {
    const fetchFn = queueResponses(oauthError('expired_token'))
    const sleep = vi.fn(async (_ms: number) => {})

    const handle = startDeviceTokenPoll({ ...baseOptions(), fetchFn, sleep })
    const err = await handle.promise.then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('expired_token')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect((err as TokenPollError).message).not.toContain(DEVICE_CODE)
  })

  it('rejects with TokenPollError (http_error) on an unknown OAuth error, surfacing the code', async () => {
    const fetchFn = queueResponses(
      jsonResponse(JSON.stringify({ error: 'invalid_grant', error_description: 'code reused' }), 400),
    )
    const sleep = vi.fn(async (_ms: number) => {})

    const handle = startDeviceTokenPoll({ ...baseOptions(), fetchFn, sleep })
    const err = await handle.promise.then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('http_error')
    expect((err as TokenPollError).status).toBe(400)
    expect((err as TokenPollError).message).toContain('invalid_grant')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('rejects with TokenPollError (http_error) on a non-2xx body with no OAuth error field', async () => {
    const fetchFn = queueResponses(new Response('<html>gateway</html>', { status: 503 }))
    const sleep = vi.fn(async (_ms: number) => {})

    const handle = startDeviceTokenPoll({ ...baseOptions(), fetchFn, sleep })
    await expect(handle.promise).rejects.toMatchObject({ code: 'http_error', status: 503 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('rejects with TokenPollError (network_error, cause) when fetch itself rejects', async () => {
    const cause = new Error('ECONNREFUSED')
    const fetchFn = vi.fn(async () => {
      throw cause
    })
    const sleep = vi.fn(async (_ms: number) => {})

    const handle = startDeviceTokenPoll({ ...baseOptions(), fetchFn, sleep })
    const err = await handle.promise.then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('network_error')
    expect((err as TokenPollError).cause).toBe(cause)
    expect((err as TokenPollError).message).not.toContain(DEVICE_CODE)
  })

  it('rejects with TokenPollError (invalid_response) wrapping the parse failure on a malformed success body', async () => {
    const fetchFn = queueResponses(jsonResponse('not json'))
    const sleep = vi.fn(async (_ms: number) => {})

    const handle = startDeviceTokenPoll({ ...baseOptions(), fetchFn, sleep })
    const err = await handle.promise.then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('invalid_response')
    expect((err as TokenPollError).cause).toBeInstanceOf(TokenSetError)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

// ────────────────────────────────────────────────────────────
// Cancellation
// ────────────────────────────────────────────────────────────

describe('startDeviceTokenPoll cancellation', () => {
  it('cancel() rejects the promise promptly (even mid-sleep) and stops polling', async () => {
    const fetchFn = queueResponses(pending(), pending())
    const clock = fakeClock()
    const gates: Array<() => void> = []
    const sleep = vi.fn((_ms: number) => new Promise<void>((resolve) => gates.push(resolve)))

    const handle = startDeviceTokenPoll({ ...baseOptions(), fetchFn, sleep })
    await until(() => sleep.mock.calls.length === 1) // first poll answered, now sleeping

    handle.cancel()
    const err = await handle.promise.then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('cancelled')
    expect((err as TokenPollError).message).not.toContain(DEVICE_CODE)

    // Release the dangling sleep; the loop must not poll again
    gates[0]()
    await until(() => fetchFn.mock.calls.length >= 1)
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('cancel() is idempotent — a second call does not double-reject', async () => {
    const fetchFn = queueResponses(pending())
    const gates: Array<() => void> = []
    const sleep = vi.fn((_ms: number) => new Promise<void>((resolve) => gates.push(resolve)))

    const handle = startDeviceTokenPoll({ ...baseOptions(), fetchFn, sleep })
    await until(() => sleep.mock.calls.length === 1)

    handle.cancel()
    handle.cancel()

    await expect(handle.promise).rejects.toMatchObject({ code: 'cancelled' })
  })
})

// ────────────────────────────────────────────────────────────
// expires_in deadline
// ────────────────────────────────────────────────────────────

describe('startDeviceTokenPoll expires_in deadline', () => {
  it('stops polling and rejects with poll_expired once expires_in elapses', async () => {
    const fetchFn = queueResponses(pending(), pending())
    const clock = fakeClock()
    const sleep = clockAdvancingSleep(clock)

    // interval 5 s, device_code valid 10 s: polls at t=0 and t=5, deadline hit at t=10
    const handle = startDeviceTokenPoll({ ...baseOptions(), expiresIn: 10, fetchFn, sleep, now: clock.now })
    const err = await handle.promise.then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TokenPollError)
    expect((err as TokenPollError).code).toBe('poll_expired')
    expect((err as TokenPollError).message).not.toContain(DEVICE_CODE)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5_000, 5_000])
  })

  it('keeps polling while the deadline is still in the future', async () => {
    const fetchFn = queueResponses(pending(), pending(), tokenSuccess())
    const clock = fakeClock()
    const sleep = clockAdvancingSleep(clock)

    // interval 5 s, valid 20 s: polls at t=0, 5, 10 — all inside the window
    const handle = startDeviceTokenPoll({ ...baseOptions(), expiresIn: 20, fetchFn, sleep, now: clock.now })
    await expect(handle.promise).resolves.toMatchObject({ accessToken: 'access-1' })
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })
})
