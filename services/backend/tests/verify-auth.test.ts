/**
 * Unit suite for the `verifyAuth` plugin and `GET /whoami`.
 *
 * All tokens are REAL: minted with `SignJWT` over locally generated RSA
 * keys and verified through `createRemoteJWKSet` pointed at a local HTTP
 * JWKS server — signatures, claim checks, caching, and `kid` rotation are
 * exercised end-to-end, never mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { generateTestKey, JwksTestServer, type TestKey } from './helpers/jwks-server.js'
import { signAccessToken } from './helpers/tokens.js'

const ISSUER = 'https://auth.test/realms/genoffice'
const AUDIENCE = 'genoffice-backend'

let jwks: JwksTestServer
let keyA: TestKey
let keyB: TestKey
let attackerKey: TestKey
let app: FastifyInstance

beforeAll(async () => {
  jwks = await JwksTestServer.start()
  keyA = await generateTestKey('kid-a')
  keyB = await generateTestKey('kid-b')
  attackerKey = await generateTestKey('kid-attacker')
  jwks.setKeys([keyA])
  app = await buildApp({
    config: {
      port: 0,
      host: '127.0.0.1',
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: jwks.url,
      clockSkewSeconds: 30,
    },
    logger: false,
  })
})

afterAll(async () => {
  await app.close()
  await jwks.stop()
})

beforeEach(() => {
  // Baseline key set; individual tests that rotate reset it themselves.
  jwks.setKeys([keyA])
})

/** Fresh valid claims; tests override single fields. */
function claims(overrides: Partial<Parameters<typeof signAccessToken>[2]> = {}) {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-1',
    realmAccessRoles: ['default-roles-genoffice'],
    scope: 'openid profile email',
    ...overrides,
  }
}

describe('GET /whoami happy paths', () => {
  it('returns the verified identity (sub, roles, scope) for a valid token', async () => {
    const token = await signAccessToken(keyA.privateKey, keyA.kid, claims())
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      sub: 'user-1',
      roles: ['default-roles-genoffice'],
      scope: 'openid profile email',
    })
  })

  it('omits roles/scope keys when the token carries none', async () => {
    const token = await signAccessToken(keyA.privateKey, keyA.kid, {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'minimal-user',
    })
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ sub: 'minimal-user' })
  })

  it('accepts a token expired seconds ago within the 30 s clock skew', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const token = await signAccessToken(keyA.privateKey, keyA.kid, claims({ exp: nowSeconds - 10 }))
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sub: 'user-1' })
  })
})

describe('401 rejections', () => {
  async function expectUnauthorized(token: string, expectedCode: string): Promise<void> {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/)
    expect(res.json()).toEqual({ error: { code: expectedCode, message: expect.any(String) } })
    // No token material may leak into the error body.
    expect(res.body).not.toContain(token)
  }

  it('rejects a wrong issuer', async () => {
    const token = await signAccessToken(
      keyA.privateKey,
      keyA.kid,
      claims({ iss: 'https://evil.test/realms/other' }),
    )
    await expectUnauthorized(token, 'invalid_token')
  })

  it('rejects a wrong audience', async () => {
    const token = await signAccessToken(
      keyA.privateKey,
      keyA.kid,
      claims({ aud: 'some-other-api' }),
    )
    await expectUnauthorized(token, 'invalid_token')
  })

  it('rejects an expired token beyond the clock skew', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const token = await signAccessToken(
      keyA.privateKey,
      keyA.kid,
      claims({ exp: nowSeconds - 120 }),
    )
    await expectUnauthorized(token, 'invalid_token')
  })

  it('rejects a bad signature (published kid, attacker key)', async () => {
    const token = await signAccessToken(attackerKey.privateKey, keyA.kid, claims())
    await expectUnauthorized(token, 'invalid_token')
  })

  it('rejects an unknown kid that never appears in the JWKS', async () => {
    const token = await signAccessToken(attackerKey.privateKey, attackerKey.kid, claims())
    await expectUnauthorized(token, 'invalid_token')
  })

  it('rejects a garbage bearer value', async () => {
    await expectUnauthorized('!!!not-a-jwt!!!', 'invalid_token')
  })

  it('rejects a missing Authorization header with WWW-Authenticate', async () => {
    const res = await app.inject({ method: 'GET', url: '/whoami' })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer realm="genoffice"')
    expect(res.json()).toEqual({
      error: { code: 'missing_token', message: expect.any(String) },
    })
  })

  it('rejects a non-Bearer scheme as a missing token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({
      error: { code: 'missing_token', message: expect.any(String) },
    })
  })
})

describe('JWKS kid rotation', () => {
  it('refetches the JWKS on an unknown kid and verifies the new key', async () => {
    // jose rate-limits unknown-kid refetches with a 30 s cooldown; this app
    // tightens it to 100 ms so the rotation is exercisable without waiting.
    const rotationApp = await buildApp({
      config: {
        port: 0,
        host: '127.0.0.1',
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: jwks.url,
        clockSkewSeconds: 30,
      },
      logger: false,
      jwksCooldownMs: 100,
    })
    try {
      // Prime the cache with key set A only.
      const first = await signAccessToken(keyA.privateKey, keyA.kid, claims())
      const res1 = await rotationApp.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: `Bearer ${first}` },
      })
      expect(res1.statusCode).toBe(200)
      const fetchesAfterFirst = jwks.fetchCount

      // Realm rotation: Keycloak publishes B alongside A; a token signed by
      // B carries an unknown kid until the JWKS is refetched past cooldown.
      jwks.setKeys([keyA, keyB])
      await new Promise((resolve) => setTimeout(resolve, 150))
      const rotated = await signAccessToken(keyB.privateKey, keyB.kid, claims({ sub: 'user-2' }))
      const res2 = await rotationApp.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: `Bearer ${rotated}` },
      })
      expect(res2.statusCode).toBe(200)
      expect(res2.json()).toMatchObject({ sub: 'user-2' })
      // The unknown kid really did trigger an extra JWKS fetch.
      expect(jwks.fetchCount).toBeGreaterThan(fetchesAfterFirst)
    } finally {
      await rotationApp.close()
    }
  })
})

describe('validation infrastructure failures', () => {
  it('answers 500 with a stable code when the JWKS endpoint is unreachable', async () => {
    // A stopped server leaves behind a port that refuses connections
    // instantly — deterministic, unlike an unroutable address.
    const dead = await JwksTestServer.start()
    const deadUrl = dead.url
    await dead.stop()

    const brokenApp = await buildApp({
      config: {
        port: 0,
        host: '127.0.0.1',
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: deadUrl,
        clockSkewSeconds: 30,
      },
      logger: false,
    })
    try {
      const token = await signAccessToken(keyA.privateKey, keyA.kid, claims())
      const res = await brokenApp.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({
        error: { code: 'validation_unavailable', message: expect.any(String) },
      })
      expect(res.body).not.toContain(token)
    } finally {
      await brokenApp.close()
    }
  })
})
