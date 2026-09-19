import { describe, expect, it, vi } from 'vitest'
import { requestDeviceAuthorization } from '../src/device-auth.js'
import { DeviceAuthError } from '../src/errors.js'

// ────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────

const ENDPOINT = 'http://localhost:8080/realms/genoffice/protocol/openid-connect/auth/device'
const CLIENT_ID = 'genoffice'
const SCOPE = 'openid profile offline_access'

/** RFC 8628 §3.2 device authorization response with overridable fields */
function deviceAuthJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    device_code: 'device-code-1',
    user_code: 'ABCD-EFGH',
    verification_uri: 'http://localhost:8080/realms/genoffice/device',
    verification_uri_complete: 'http://localhost:8080/realms/genoffice/device?user_code=ABCD-EFGH',
    expires_in: 600,
    interval: 7,
    ...overrides,
  })
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** Fetch mock ignoring its arguments but recording them (so tests can assert on the request) */
function mockFetch(respond: () => Response) {
  return vi.fn(async (_url: string, _init?: RequestInit) => respond())
}

// ────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────

describe('requestDeviceAuthorization happy path', () => {
  it('POSTs client_id and scope as a form body and parses the response', async () => {
    const fetchFn = mockFetch(() => jsonResponse(deviceAuthJson()))

    const result = await requestDeviceAuthorization({
      endpoint: ENDPOINT,
      clientId: CLIENT_ID,
      scope: SCOPE,
      fetchFn,
    })

    // Request shape
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(ENDPOINT)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(String(init?.body))
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('scope')).toBe(SCOPE)

    // Parsed response
    expect(result.deviceCode).toBe('device-code-1')
    expect(result.userCode).toBe('ABCD-EFGH')
    expect(result.verificationUri).toBe('http://localhost:8080/realms/genoffice/device')
    expect(result.verificationUriComplete).toBe(
      'http://localhost:8080/realms/genoffice/device?user_code=ABCD-EFGH',
    )
    expect(result.expiresIn).toBe(600)
    expect(result.interval).toBe(7)
  })

  it('omits the scope parameter when no scope is given', async () => {
    const fetchFn = mockFetch(() => jsonResponse(deviceAuthJson()))
    await requestDeviceAuthorization({ endpoint: ENDPOINT, clientId: CLIENT_ID, fetchFn })

    const body = new URLSearchParams(String(fetchFn.mock.calls[0][1]?.body))
    expect(body.has('scope')).toBe(false)
  })

  it('defaults interval to the RFC 8628 default (5s) when the server omits it', async () => {
    const fetchFn = async () => jsonResponse(deviceAuthJson({ interval: undefined }))
    const result = await requestDeviceAuthorization({
      endpoint: ENDPOINT,
      clientId: CLIENT_ID,
      fetchFn,
    })
    expect(result.interval).toBe(5)
  })

  it('leaves verificationUriComplete undefined when the server omits it', async () => {
    const fetchFn = async () =>
      jsonResponse(deviceAuthJson({ verification_uri_complete: undefined }))
    const result = await requestDeviceAuthorization({
      endpoint: ENDPOINT,
      clientId: CLIENT_ID,
      fetchFn,
    })
    expect(result.verificationUriComplete).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────
// Failure modes
// ────────────────────────────────────────────────────────────

describe('requestDeviceAuthorization failures', () => {
  it('throws DeviceAuthError (http_error, status) on non-2xx, surfacing the OAuth error code', async () => {
    const fetchFn = async () =>
      jsonResponse(
        JSON.stringify({ error: 'invalid_client', error_description: 'client not registered' }),
        400,
      )

    const err = await requestDeviceAuthorization({
      endpoint: ENDPOINT,
      clientId: CLIENT_ID,
      fetchFn,
    })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DeviceAuthError)
    expect((err as DeviceAuthError).code).toBe('http_error')
    expect((err as DeviceAuthError).status).toBe(400)
    expect((err as DeviceAuthError).message).toContain('invalid_client')
    // device_code never leaks into the error surface
    expect((err as DeviceAuthError).message).not.toContain('device-code')
  })

  it('throws DeviceAuthError (invalid_response) when device_code is missing', async () => {
    const fetchFn = async () => jsonResponse(deviceAuthJson({ device_code: undefined }))

    await expect(
      requestDeviceAuthorization({ endpoint: ENDPOINT, clientId: CLIENT_ID, fetchFn }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('throws DeviceAuthError (invalid_response) when expires_in is not a positive number', async () => {
    const fetchFn = async () => jsonResponse(deviceAuthJson({ expires_in: 'soon' }))

    await expect(
      requestDeviceAuthorization({ endpoint: ENDPOINT, clientId: CLIENT_ID, fetchFn }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('throws DeviceAuthError (network_error) when fetch itself rejects', async () => {
    const cause = new Error('ECONNREFUSED')
    const fetchFn = async () => {
      throw cause
    }

    const err = await requestDeviceAuthorization({
      endpoint: ENDPOINT,
      clientId: CLIENT_ID,
      fetchFn,
    })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DeviceAuthError)
    expect((err as DeviceAuthError).code).toBe('network_error')
    expect((err as DeviceAuthError).cause).toBe(cause)
  })
})
