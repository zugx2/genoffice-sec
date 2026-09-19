import { describe, expect, it } from 'vitest'
import { decodeJwt, isJwtExpired, parseTokenResponse, validateIdToken } from '../src/token-set.js'
import { TokenSetError } from '../src/errors.js'

// ────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────

const ISSUER = 'http://localhost:8080/realms/genoffice'
const CLIENT_ID = 'genoffice'
/** Fixed "now" for expiry checks */
const NOW = 1_700_000_000_000

/** base64url-encode a JSON segment the way a real JWT serializer would */
function encodeSegment(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Unsigned-for-test-purposes JWT: real base64url header/payload, opaque signature */
function jwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' },
): string {
  return `${encodeSegment(header)}.${encodeSegment(payload)}.signature-not-verified`
}

/** OAuth token endpoint success payload with overridable fields */
function tokenResponseJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 300,
    refresh_token: 'refresh-1',
    id_token: 'id-1',
    scope: 'openid profile offline_access',
    ...overrides,
  })
}

/** Frozen clock for expiry assertions */
const atNow = (): number => NOW

// ────────────────────────────────────────────────────────────
// parseTokenResponse
// ────────────────────────────────────────────────────────────

describe('parseTokenResponse', () => {
  it('maps the OAuth token endpoint payload to a TokenSet', () => {
    const set = parseTokenResponse(tokenResponseJson())

    expect(set.accessToken).toBe('access-1')
    expect(set.tokenType).toBe('Bearer')
    expect(set.expiresIn).toBe(300)
    expect(set.refreshToken).toBe('refresh-1')
    expect(set.idToken).toBe('id-1')
    expect(set.scope).toBe('openid profile offline_access')
  })

  it('leaves optional tokens undefined when the server omits them', () => {
    const set = parseTokenResponse(
      tokenResponseJson({
        refresh_token: undefined,
        id_token: undefined,
        scope: undefined,
        expires_in: undefined,
      }),
    )

    expect(set.refreshToken).toBeUndefined()
    expect(set.idToken).toBeUndefined()
    expect(set.scope).toBeUndefined()
    expect(set.expiresIn).toBeUndefined()
  })

  it('throws TokenSetError (invalid_response) when access_token is missing', () => {
    expect(() => parseTokenResponse(tokenResponseJson({ access_token: undefined }))).toThrow(
      TokenSetError,
    )
    expect(() => parseTokenResponse(tokenResponseJson({ access_token: '' }))).toThrow(TokenSetError)
    expect(() => parseTokenResponse(tokenResponseJson({ access_token: undefined }))).toThrow(
      expect.objectContaining({ code: 'invalid_response' }),
    )
  })

  it('throws TokenSetError (invalid_response) on non-JSON or non-object payloads', () => {
    expect(() => parseTokenResponse('not json')).toThrow(TokenSetError)
    expect(() => parseTokenResponse('["array"]')).toThrow(TokenSetError)
    expect(() => parseTokenResponse('42')).toThrow(
      expect.objectContaining({ code: 'invalid_response' }),
    )
  })
})

// ────────────────────────────────────────────────────────────
// decodeJwt
// ────────────────────────────────────────────────────────────

describe('decodeJwt', () => {
  it('decodes header and payload claims (including non-ASCII UTF-8)', () => {
    const token = jwt({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'user-1',
      name: '张三',
      email: 'zhang@example.test',
    })

    const decoded = decodeJwt(token)

    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decoded.payload['iss']).toBe(ISSUER)
    expect(decoded.payload['aud']).toBe(CLIENT_ID)
    expect(decoded.payload['sub']).toBe('user-1')
    expect(decoded.payload['name']).toBe('张三')
    expect(decoded.payload['email']).toBe('zhang@example.test')
  })

  it('throws TokenSetError (invalid_jwt) when the token does not have three non-empty segments', () => {
    const twoSegments = `${encodeSegment({ alg: 'none' })}.${encodeSegment({ sub: 'user-1' })}`
    expect(() => decodeJwt(twoSegments)).toThrow(TokenSetError)
    expect(() => decodeJwt(`${encodeSegment({ alg: 'none' })}..sig`)).toThrow(
      expect.objectContaining({ code: 'invalid_jwt' }),
    )
  })

  it('throws TokenSetError (invalid_jwt) on non-base64url characters', () => {
    expect(() => decodeJwt('a!b.c!d.sig')).toThrow(expect.objectContaining({ code: 'invalid_jwt' }))
  })

  it('throws TokenSetError (invalid_jwt) when a segment is not a JSON object', () => {
    expect(() => decodeJwt(`${encodeSegment({ alg: 'none' })}.${encodeSegment(5)}.sig`)).toThrow(
      expect.objectContaining({ code: 'invalid_jwt' }),
    )
    // `e30` is unpadded base64url for `{}` — valid empty payload object
    expect(() => decodeJwt(`${encodeSegment({ alg: 'none' })}.e30.sig`)).not.toThrow()
  })
})

// ────────────────────────────────────────────────────────────
// isJwtExpired
// ────────────────────────────────────────────────────────────

describe('isJwtExpired', () => {
  it('reports a token expiring well in the future as fresh, with and without skew', () => {
    const token = jwt({ exp: (NOW + 60_000) / 1000 })

    expect(isJwtExpired(token, { now: atNow, skewMs: 0 })).toBe(false)
    expect(isJwtExpired(token, { now: atNow, skewMs: 30_000 })).toBe(false)
  })

  it('reports a token whose exp is in the past as expired, with and without skew', () => {
    const token = jwt({ exp: (NOW - 10_000) / 1000 })

    expect(isJwtExpired(token, { now: atNow, skewMs: 0 })).toBe(true)
    expect(isJwtExpired(token, { now: atNow, skewMs: 30_000 })).toBe(true)
  })

  it('applies the skew window before exp (conservative: refresh early)', () => {
    // exp 10 s in the future: fresh with no skew, expired inside the 30 s window
    const token = jwt({ exp: (NOW + 10_000) / 1000 })

    expect(isJwtExpired(token, { now: atNow, skewMs: 0 })).toBe(false)
    expect(isJwtExpired(token, { now: atNow, skewMs: 30_000 })).toBe(true)
  })

  it('default skew is 30 s: boundary is inclusive at exp − 30 s', () => {
    expect(isJwtExpired(jwt({ exp: (NOW + 30_000) / 1000 }), { now: atNow })).toBe(true)
    expect(isJwtExpired(jwt({ exp: (NOW + 29_999) / 1000 }), { now: atNow })).toBe(true)
    expect(isJwtExpired(jwt({ exp: (NOW + 30_001) / 1000 }), { now: atNow })).toBe(false)
  })

  it('fails safe: a payload without a usable numeric exp reports expired', () => {
    expect(isJwtExpired(jwt({ sub: 'user-1' }), { now: atNow })).toBe(true)
    expect(isJwtExpired(jwt({ exp: 'soon' }), { now: atNow })).toBe(true)
    expect(isJwtExpired(jwt({ exp: null }), { now: atNow })).toBe(true)
  })

  it('throws TokenSetError (invalid_jwt) when the input is not a JWT', () => {
    expect(() => isJwtExpired('garbage', { now: atNow })).toThrow(
      expect.objectContaining({ code: 'invalid_jwt' }),
    )
  })
})

// ────────────────────────────────────────────────────────────
// validateIdToken
// ────────────────────────────────────────────────────────────

describe('validateIdToken claim checks', () => {
  it('accepts an id token whose iss/aud/sub match and returns its claims (string-form aud)', () => {
    const token = jwt({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'user-1',
      name: 'Alice',
      email: 'alice@example.test',
      exp: (NOW + 300_000) / 1000,
    })

    const claims = validateIdToken(token, { issuer: ISSUER, audience: CLIENT_ID })

    expect(claims.sub).toBe('user-1')
    expect(claims['iss']).toBe(ISSUER)
    expect(claims['name']).toBe('Alice')
    expect(claims['email']).toBe('alice@example.test')
  })

  it('accepts an array-form aud that contains the configured audience', () => {
    const token = jwt({ iss: ISSUER, aud: ['account', CLIENT_ID], sub: 'user-1' })

    expect(() => validateIdToken(token, { issuer: ISSUER, audience: CLIENT_ID })).not.toThrow()
  })

  it('throws TokenSetError (iss_mismatch) when iss does not equal the configured issuer', () => {
    const token = jwt({
      iss: 'http://evil.example.test/realms/other',
      aud: CLIENT_ID,
      sub: 'user-1',
    })

    expect(() => validateIdToken(token, { issuer: ISSUER, audience: CLIENT_ID })).toThrow(
      TokenSetError,
    )
    expect(() => validateIdToken(token, { issuer: ISSUER, audience: CLIENT_ID })).toThrow(
      expect.objectContaining({ code: 'iss_mismatch' }),
    )
  })

  it('throws TokenSetError (aud_mismatch) on a string-form aud naming another client', () => {
    const token = jwt({ iss: ISSUER, aud: 'other-client', sub: 'user-1' })

    expect(() => validateIdToken(token, { issuer: ISSUER, audience: CLIENT_ID })).toThrow(
      expect.objectContaining({ code: 'aud_mismatch' }),
    )
  })

  it('throws TokenSetError (aud_mismatch) on an array-form aud without the configured audience', () => {
    const token = jwt({ iss: ISSUER, aud: ['account', 'other-client'], sub: 'user-1' })

    expect(() => validateIdToken(token, { issuer: ISSUER, audience: CLIENT_ID })).toThrow(
      TokenSetError,
    )
    expect(() => validateIdToken(token, { issuer: ISSUER, audience: CLIENT_ID })).toThrow(
      expect.objectContaining({ code: 'aud_mismatch' }),
    )
  })

  it('throws TokenSetError (aud_mismatch) when the aud claim is missing entirely', () => {
    const token = jwt({ iss: ISSUER, sub: 'user-1' })

    expect(() => validateIdToken(token, { issuer: ISSUER, audience: CLIENT_ID })).toThrow(
      expect.objectContaining({ code: 'aud_mismatch' }),
    )
  })

  it('throws TokenSetError (missing_sub) when sub is absent or empty', () => {
    expect(() =>
      validateIdToken(jwt({ iss: ISSUER, aud: CLIENT_ID }), {
        issuer: ISSUER,
        audience: CLIENT_ID,
      }),
    ).toThrow(expect.objectContaining({ code: 'missing_sub' }))
    expect(() =>
      validateIdToken(jwt({ iss: ISSUER, aud: CLIENT_ID, sub: '' }), {
        issuer: ISSUER,
        audience: CLIENT_ID,
      }),
    ).toThrow(expect.objectContaining({ code: 'missing_sub' }))
  })
})
