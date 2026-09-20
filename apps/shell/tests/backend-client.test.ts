import { describe, expect, it, vi } from 'vitest'
import {
  AuthFlowError,
  type FetchLike,
  type StoredTokenSet,
  type TokenStore,
} from '@genoffice/auth'

import { BackendClient, BackendClientError } from '../src/main/auth/backend-client'
import type { BackendSession } from '../src/main/auth/backend-client'
import { AuthSessionManager } from '../src/main/auth/session-manager'

// ── session double: scripted token service, refresh counted ──

function sessionDouble(tokens: string[]): BackendSession & {
  calls: Array<{ force?: boolean }>
  rejectWith(error: unknown): void
} {
  const calls: Array<{ force?: boolean }> = []
  let reject: unknown = undefined
  let index = 0
  return {
    calls,
    rejectWith(error: unknown): void {
      reject = error
    },
    async getAccessToken(options: { force?: boolean } = {}): Promise<string> {
      calls.push({ force: options.force })
      if (reject !== undefined) throw reject
      const token = tokens[Math.min(index, tokens.length - 1)]
      index += 1
      return token
    },
  }
}

/** Scripted backend fetch: per-call Responses, one per request. */
function backendFetch(responses: Array<() => Response>): FetchLike & { calls: string[] } {
  const calls: string[] = []
  let index = 0
  const fn = (async (url: string) => {
    calls.push(url)
    const handler = responses[Math.min(index, responses.length - 1)]
    index += 1
    return handler()
  }) as FetchLike & { calls: string[] }
  fn.calls = calls
  return fn
}

const ok = () => new Response(JSON.stringify({ sub: 'user-1' }), { status: 200 })
const unauthorized = () => new Response(JSON.stringify({ error: 'Bearer' }), { status: 401 })
const serverError = () => new Response('boom', { status: 500 })

async function makeClient(
  baseUrl = 'http://localhost:8000',
  session: BackendSession = sessionDouble(['token-1']),
  fetchFn: FetchLike = backendFetch([ok]),
): Promise<BackendClient> {
  return BackendClient.create({ baseUrl, session, fetchFn })
}

describe('BackendClient.create (construction gate)', () => {
  it('accepts the dev default loopback URL', async () => {
    await expect(makeClient()).resolves.toBeTruthy()
  })

  it.each(['file:///etc/passwd', 'ftp://example.test/x', 'not a url'])(
    'fails construction with a typed config error for %s',
    async (baseUrl) => {
      const rejection = makeClient(baseUrl)
      await expect(rejection).rejects.toBeInstanceOf(BackendClientError)
      await expect(rejection).rejects.toMatchObject({ code: 'config' })
    },
  )

  it('fails construction for a URL with embedded credentials', async () => {
    await expect(makeClient('http://user:secret@localhost:8000')).rejects.toMatchObject({
      code: 'config',
    })
  })

  it('never embeds the offending URL in the config error', async () => {
    const secret = 'http://user:secret@localhost:8000'
    const error = await makeClient(secret).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackendClientError)
    expect((error as Error).message).not.toContain('secret')
  })
})

describe('BackendClient.fetch (Bearer attach, refresh-once-on-401)', () => {
  it('attaches the session token as a Bearer header and joins the base path', async () => {
    const session = sessionDouble(['token-1'])
    const fetchFn = backendFetch([ok])
    const client = await makeClient('https://api.example.test/v1', session, fetchFn)

    const response = await client.fetch('whoami')
    expect(response.status).toBe(200)
    expect(fetchFn.calls).toEqual(['https://api.example.test/v1/whoami'])
    expect(session.calls).toEqual([{}]) // no forced refresh on the happy path
  })

  it('sends the authorization header and keeps caller headers', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetchFn: FetchLike = async (url, init) => {
      seen = { url, init: init ?? {} }
      return ok()
    }
    const client = await makeClient('http://localhost:8000', sessionDouble(['token-1']), fetchFn)

    await client.fetch('/whoami', { headers: { accept: 'application/json' } })
    expect(seen?.url).toBe('http://localhost:8000/whoami')
    const headers = new Headers(seen?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer token-1')
    expect(headers.get('accept')).toBe('application/json')
  })

  it('on 401 forces exactly one refresh and retries once with the new token', async () => {
    const session = sessionDouble(['token-1', 'token-2'])
    const fetchFn = backendFetch([unauthorized, ok])
    const client = await makeClient('http://localhost:8000', session, fetchFn)

    const response = await client.fetch('/whoami')
    expect(response.status).toBe(200)
    expect(fetchFn.calls).toEqual(['http://localhost:8000/whoami', 'http://localhost:8000/whoami'])
    // first call unforced, second forced — one refresh, not a loop
    expect(session.calls).toEqual([{}, { force: true }])
  })

  it('surfaces a second 401 instead of retrying again', async () => {
    const session = sessionDouble(['token-1', 'token-2'])
    const fetchFn = backendFetch([unauthorized, unauthorized, ok])
    const client = await makeClient('http://localhost:8000', session, fetchFn)

    const response = await client.fetch('/whoami')
    expect(response.status).toBe(401)
    expect(fetchFn.calls).toHaveLength(2)
    expect(session.calls).toEqual([{}, { force: true }])
  })

  it('propagates the typed auth error when logged out, without any request', async () => {
    const session = sessionDouble(['token-1'])
    session.rejectWith(
      new AuthFlowError('No session to serve an access token from', { code: 'not_logged_in' }),
    )
    const fetchFn = backendFetch([ok])
    const client = await makeClient('http://localhost:8000', session, fetchFn)

    await expect(client.fetch('/whoami')).rejects.toMatchObject({ code: 'not_logged_in' })
    expect(fetchFn.calls).toEqual([])
  })
})

describe('BackendClient.probe (whoami → {ok, status?})', () => {
  it('reports connected with the status on a 2xx', async () => {
    const fetchFn = backendFetch([ok])
    const client = await makeClient('http://localhost:8000', sessionDouble(['token-1']), fetchFn)
    await expect(client.probe()).resolves.toEqual({ ok: true, status: 200 })
    expect(fetchFn.calls).toEqual(['http://localhost:8000/whoami'])
  })

  it('reports not connected with the status on a non-2xx answer', async () => {
    const client = await makeClient(
      'http://localhost:8000',
      sessionDouble(['token-1']),
      backendFetch([serverError]),
    )
    await expect(client.probe()).resolves.toEqual({ ok: false, status: 500 })
  })

  it('reports not connected without a status when nothing answered (network / logged out)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const failing: FetchLike = async () => {
        throw new TypeError('fetch failed')
      }
      const client = await makeClient('http://localhost:8000', sessionDouble(['token-1']), failing)
      await expect(client.probe()).resolves.toEqual({ ok: false })
    } finally {
      warn.mockRestore()
    }
  })

  it('never carries a token or URL in its result payload', async () => {
    const client = await makeClient(
      'http://localhost:8000',
      sessionDouble(['secret-access-token']),
      backendFetch([unauthorized, unauthorized]),
    )
    const result = await client.probe()
    expect(JSON.stringify(result)).not.toContain('secret-access-token')
    expect(JSON.stringify(result)).not.toContain('http')
  })
})

// ── integration with the real session manager (the token seam) ──

const ISSUER = 'http://localhost:8080/realms/genoffice'
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
const DEVICE_ENDPOINT = `${ISSUER}/protocol/openid-connect/auth/device`
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`
const CLIENT_ID = 'genoffice-desktop'
const BACKEND = 'http://localhost:8000'

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const ID_TOKEN = [
  b64url({ alg: 'RS256', typ: 'JWT' }),
  b64url({ iss: ISSUER, aud: CLIENT_ID, sub: 'user-1', exp: 4_102_444_800 }),
  b64url({ sig: true }),
].join('.')

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

/** Issuer-side fetch: discovery + device flow + refresh grant, counting token calls. */
function issuerFetch(): FetchLike & { tokenCalls(): number } {
  let tokenCalls = 0
  const fn = (async (url: string): Promise<Response> => {
    if (url === DISCOVERY_URL) {
      return jsonResponse(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: TOKEN_ENDPOINT,
          device_authorization_endpoint: DEVICE_ENDPOINT,
        }),
      )
    }
    if (url === DEVICE_ENDPOINT) {
      return jsonResponse(
        JSON.stringify({
          device_code: 'device-code-1',
          user_code: 'ABCD-EFGH',
          verification_uri: `${ISSUER}/device`,
          verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        }),
      )
    }
    if (url === TOKEN_ENDPOINT) {
      tokenCalls += 1
      return jsonResponse(
        JSON.stringify({
          access_token: `access-${tokenCalls}`,
          token_type: 'Bearer',
          expires_in: 300,
          refresh_token: `refresh-${tokenCalls}`,
          id_token: ID_TOKEN,
        }),
      )
    }
    throw new Error(`unexpected issuer fetch: ${url}`)
  }) as FetchLike & { tokenCalls(): number }
  fn.tokenCalls = () => tokenCalls
  return fn
}

function memoryStore(): TokenStore {
  let saved: StoredTokenSet | null = null
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
  }
}

describe('BackendClient + AuthSessionManager (probe at the manager level)', () => {
  it('a 401 from the backend refreshes once through the manager and the retry connects', async () => {
    const issuer = issuerFetch()
    const manager = new AuthSessionManager({
      config: { issuer: ISSUER, clientId: CLIENT_ID },
      store: memoryStore(),
      storageKind: () => 'encrypted',
      openExternal: () => {},
      fetchFn: issuer,
      sleep: async () => {},
    })
    await manager.startLogin()
    expect(issuer.tokenCalls()).toBe(1)

    // first whoami rejects the login-minted token; the retry uses access-2
    const sentTokens: string[] = []
    const backendFetchFn: FetchLike = async (url, init) => {
      expect(url).toBe(`${BACKEND}/whoami`)
      sentTokens.push(new Headers(init?.headers).get('authorization') ?? '')
      return sentTokens.length === 1 ? unauthorized() : ok()
    }
    const client = await BackendClient.create({
      baseUrl: BACKEND,
      session: manager,
      fetchFn: backendFetchFn,
    })

    await expect(client.probe()).resolves.toEqual({ ok: true, status: 200 })
    expect(sentTokens).toEqual(['Bearer access-1', 'Bearer access-2'])
    // exactly one forced refresh: the login mint + the 401-driven refresh
    expect(issuer.tokenCalls()).toBe(2)
    expect(manager.snapshot().status).toBe('authenticated')
  })
})
