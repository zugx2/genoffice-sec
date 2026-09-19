import { describe, expect, it, vi } from 'vitest'
import { DiscoveryClient } from '../src/discovery.js'
import { DiscoveryError } from '../src/errors.js'

// ────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────

const ISSUER = 'http://localhost:8080/realms/genoffice'
const WELL_KNOWN = `${ISSUER}/.well-known/openid-configuration`

/** Keycloak-shaped discovery document with overridable fields */
function discoveryJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    device_authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth/device`,
    revocation_endpoint: `${ISSUER}/protocol/openid-connect/revoke`,
    end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
    ...overrides,
  })
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** Controllable clock */
function fakeClock(startAt = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = startAt
  return { now: () => t, advance: (ms) => (t += ms) }
}

/** Fetch mock ignoring its arguments but recording them (so tests can assert on the request) */
function mockFetch(respond: () => Response) {
  return vi.fn(async (_url: string, _init?: RequestInit) => respond())
}

// ────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────

describe('DiscoveryClient happy path', () => {
  it('fetches <issuer>/.well-known/openid-configuration and maps the endpoints', async () => {
    const fetchFn = mockFetch(() => jsonResponse(discoveryJson()))
    const client = new DiscoveryClient({ issuer: ISSUER, fetchFn })

    const doc = await client.get()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe(WELL_KNOWN)
    expect(doc.issuer).toBe(ISSUER)
    expect(doc.authorizationEndpoint).toBe(`${ISSUER}/protocol/openid-connect/auth`)
    expect(doc.tokenEndpoint).toBe(`${ISSUER}/protocol/openid-connect/token`)
    expect(doc.deviceAuthorizationEndpoint).toBe(`${ISSUER}/protocol/openid-connect/auth/device`)
    expect(doc.revocationEndpoint).toBe(`${ISSUER}/protocol/openid-connect/revoke`)
    expect(doc.endSessionEndpoint).toBe(`${ISSUER}/protocol/openid-connect/logout`)
  })

  it('serves repeated get() calls from cache without re-fetching', async () => {
    const fetchFn = mockFetch(() => jsonResponse(discoveryJson()))
    const client = new DiscoveryClient({ issuer: ISSUER, fetchFn })

    const first = await client.get()
    const second = await client.get()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('getCached() returns undefined before the first fetch, the document after', async () => {
    const fetchFn = mockFetch(() => jsonResponse(discoveryJson()))
    const client = new DiscoveryClient({ issuer: ISSUER, fetchFn })

    expect(client.getCached()).toBeUndefined()
    await client.get()
    expect(client.getCached()).toBe(await client.get())
  })
})

// ────────────────────────────────────────────────────────────
// Failure modes
// ────────────────────────────────────────────────────────────

describe('DiscoveryClient failures', () => {
  it('throws DiscoveryError (invalid_document) on malformed JSON', async () => {
    const client = new DiscoveryClient({
      issuer: ISSUER,
      fetchFn: async () => jsonResponse('<html>not json</html>'),
    })

    await expect(client.get()).rejects.toBeInstanceOf(DiscoveryError)
    await expect(client.get()).rejects.toMatchObject({ code: 'invalid_document' })
  })

  it('throws DiscoveryError (invalid_document) when the payload is not an object', async () => {
    const client = new DiscoveryClient({
      issuer: ISSUER,
      fetchFn: async () => jsonResponse('["array", "is", "not", "an", "object"]'),
    })

    await expect(client.get()).rejects.toMatchObject({ code: 'invalid_document' })
  })

  it('throws DiscoveryError (invalid_document) when a required endpoint is missing', async () => {
    const client = new DiscoveryClient({
      issuer: ISSUER,
      fetchFn: async () => jsonResponse(JSON.stringify({ token_endpoint: `${ISSUER}/token` })),
    })

    const err = await client.get().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DiscoveryError)
    expect((err as DiscoveryError).code).toBe('invalid_document')
    expect((err as DiscoveryError).message).toContain('issuer')
  })

  it('throws DiscoveryError (invalid_document) when the document issuer differs from the configured one', async () => {
    const client = new DiscoveryClient({
      issuer: ISSUER,
      fetchFn: async () =>
        jsonResponse(discoveryJson({ issuer: 'http://attacker.example.com/realms/genoffice' })),
    })

    const err = await client.get().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DiscoveryError)
    expect((err as DiscoveryError).code).toBe('invalid_document')
    expect((err as DiscoveryError).message).toContain('issuer')
    // The mismatch must not be cached
    expect(client.getCached()).toBeUndefined()
  })

  it('accepts a document issuer that differs only by trailing slashes', async () => {
    const client = new DiscoveryClient({
      issuer: `${ISSUER}/`,
      fetchFn: async () => jsonResponse(discoveryJson()),
    })

    const doc = await client.get()
    expect(doc.issuer).toBe(ISSUER)
  })

  it('throws DiscoveryError (http_error, status) on non-2xx responses', async () => {
    const client = new DiscoveryClient({
      issuer: ISSUER,
      fetchFn: async () => jsonResponse('{"error":"not_found"}', 404),
    })

    await expect(client.get()).rejects.toMatchObject({ code: 'http_error', status: 404 })
  })

  it('throws DiscoveryError (network_error) when fetch itself rejects', async () => {
    const cause = new Error('ECONNREFUSED')
    const client = new DiscoveryClient({
      issuer: ISSUER,
      fetchFn: async () => {
        throw cause
      },
    })

    const err = await client.get().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DiscoveryError)
    expect((err as DiscoveryError).code).toBe('network_error')
    expect((err as DiscoveryError).cause).toBe(cause)
  })

  it('a failed re-fetch rejects and does not poison recovery', async () => {
    const clock = fakeClock()
    let fail = false
    let n = 0
    const client = new DiscoveryClient({
      issuer: ISSUER,
      ttlMs: 60_000,
      now: clock.now,
      fetchFn: async () => {
        if (fail) throw new Error('offline')
        return jsonResponse(discoveryJson({ token_endpoint: `${ISSUER}/token-v${++n}` }))
      },
    })

    await client.get()
    clock.advance(60_000)
    fail = true
    await expect(client.get()).rejects.toMatchObject({ code: 'network_error' })

    fail = false
    const recovered = await client.get()
    expect(recovered.tokenEndpoint).toBe(`${ISSUER}/token-v2`)
  })
})

// ────────────────────────────────────────────────────────────
// TTL expiry
// ────────────────────────────────────────────────────────────

describe('DiscoveryClient TTL expiry', () => {
  it('re-fetches once the TTL has elapsed; getCached() reports expiry', async () => {
    const clock = fakeClock()
    let n = 0
    const fetchFn = mockFetch(() =>
      jsonResponse(discoveryJson({ token_endpoint: `${ISSUER}/token-v${++n}` })),
    )
    const client = new DiscoveryClient({ issuer: ISSUER, fetchFn, now: clock.now, ttlMs: 60_000 })

    const first = await client.get()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    clock.advance(59_999)
    expect(client.getCached()).toBe(first)
    await client.get()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    clock.advance(1)
    expect(client.getCached()).toBeUndefined()

    const second = await client.get()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(second).not.toBe(first)
    expect(second.tokenEndpoint).toBe(`${ISSUER}/token-v2`)
  })

  it('default TTL is 5 minutes', async () => {
    const clock = fakeClock()
    const fetchFn = mockFetch(() => jsonResponse(discoveryJson()))
    const client = new DiscoveryClient({ issuer: ISSUER, fetchFn, now: clock.now })

    await client.get()
    clock.advance(5 * 60_000 - 1)
    expect(client.getCached()).toBeDefined()
    clock.advance(1)
    expect(client.getCached()).toBeUndefined()
  })
})
