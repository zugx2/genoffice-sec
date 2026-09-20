import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  DEFAULT_AUDIENCE,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_HOST,
  DEFAULT_ISSUER,
  DEFAULT_PORT,
  defaultJwksUrl,
  loadConfig,
} from '../src/config.js'

describe('loadConfig defaults', () => {
  it('fills every default from an empty environment', () => {
    expect(loadConfig({})).toEqual({
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
      issuer: DEFAULT_ISSUER,
      audience: DEFAULT_AUDIENCE,
      jwksUrl: `${DEFAULT_ISSUER}/protocol/openid-connect/certs`,
      clockSkewSeconds: DEFAULT_CLOCK_SKEW_SECONDS,
    })
  })

  it('treats empty-string variables as unset', () => {
    expect(loadConfig({ GENOFFICE_BACKEND_PORT: '' }).port).toBe(DEFAULT_PORT)
  })
})

describe('loadConfig overrides', () => {
  it('applies valid overrides and derives the JWKS URL from the issuer', () => {
    const config = loadConfig({
      GENOFFICE_BACKEND_PORT: '9001',
      GENOFFICE_BACKEND_HOST: '0.0.0.0',
      GENOFFICE_BACKEND_ISSUER: 'https://sso.example.com/realms/prod',
      GENOFFICE_BACKEND_AUDIENCE: 'other-audience',
      GENOFFICE_BACKEND_CLOCK_SKEW_SECONDS: '10',
    })
    expect(config).toEqual({
      port: 9001,
      host: '0.0.0.0',
      issuer: 'https://sso.example.com/realms/prod',
      audience: 'other-audience',
      jwksUrl: 'https://sso.example.com/realms/prod/protocol/openid-connect/certs',
      clockSkewSeconds: 10,
    })
  })

  it('normalizes a trailing-slash issuer (packages/auth convention)', () => {
    const config = loadConfig({ GENOFFICE_BACKEND_ISSUER: 'https://sso.example.com/realms/prod/' })
    expect(config.issuer).toBe('https://sso.example.com/realms/prod')
    expect(config.jwksUrl).toBe('https://sso.example.com/realms/prod/protocol/openid-connect/certs')
  })

  it('keeps the issuer as the iss anchor while the JWKS URL points elsewhere (Docker case)', () => {
    const config = loadConfig({
      GENOFFICE_BACKEND_ISSUER: 'http://localhost:8080/realms/genoffice',
      GENOFFICE_BACKEND_JWKS_URL:
        'http://keycloak:8080/realms/genoffice/protocol/openid-connect/certs',
    })
    expect(config.issuer).toBe('http://localhost:8080/realms/genoffice')
    expect(config.jwksUrl).toBe(
      'http://keycloak:8080/realms/genoffice/protocol/openid-connect/certs',
    )
  })
})

describe('loadConfig validation', () => {
  it('rejects a non-integer / out-of-range port naming the variable', () => {
    expect(() => loadConfig({ GENOFFICE_BACKEND_PORT: 'http' })).toThrowError(ConfigError)
    expect(() => loadConfig({ GENOFFICE_BACKEND_PORT: '0' })).toThrowError(/GENOFFICE_BACKEND_PORT/)
    expect(() => loadConfig({ GENOFFICE_BACKEND_PORT: '70000' })).toThrowError(
      /GENOFFICE_BACKEND_PORT/,
    )
  })

  it('rejects an issuer that is not an http(s) URL', () => {
    expect(() => loadConfig({ GENOFFICE_BACKEND_ISSUER: 'not a url' })).toThrowError(
      /GENOFFICE_BACKEND_ISSUER/,
    )
    expect(() => loadConfig({ GENOFFICE_BACKEND_ISSUER: 'ftp://example.com' })).toThrowError(
      /GENOFFICE_BACKEND_ISSUER/,
    )
  })

  it('rejects a malformed JWKS URL override', () => {
    expect(() => loadConfig({ GENOFFICE_BACKEND_JWKS_URL: '::not-a-url' })).toThrowError(
      /GENOFFICE_BACKEND_JWKS_URL/,
    )
  })

  it('rejects a negative or non-integer clock skew', () => {
    expect(() => loadConfig({ GENOFFICE_BACKEND_CLOCK_SKEW_SECONDS: '-5' })).toThrowError(
      /GENOFFICE_BACKEND_CLOCK_SKEW_SECONDS/,
    )
    expect(() => loadConfig({ GENOFFICE_BACKEND_CLOCK_SKEW_SECONDS: '1.5' })).toThrowError(
      /GENOFFICE_BACKEND_CLOCK_SKEW_SECONDS/,
    )
  })

  it('aggregates every problem into one message', () => {
    try {
      loadConfig({ GENOFFICE_BACKEND_PORT: 'x', GENOFFICE_BACKEND_ISSUER: 'nope' })
      expect.unreachable('loadConfig should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).message).toMatch(/GENOFFICE_BACKEND_PORT/)
      expect((err as ConfigError).message).toMatch(/GENOFFICE_BACKEND_ISSUER/)
    }
  })
})

describe('defaultJwksUrl', () => {
  it('derives Keycloak realm JWKS path', () => {
    expect(defaultJwksUrl('http://localhost:8080/realms/genoffice')).toBe(
      'http://localhost:8080/realms/genoffice/protocol/openid-connect/certs',
    )
  })
})
