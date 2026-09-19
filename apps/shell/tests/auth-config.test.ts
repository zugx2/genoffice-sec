import { describe, expect, it } from 'vitest'

import {
  DEV_AUTH_CLIENT_ID,
  DEV_AUTH_ISSUER,
  DEV_BACKEND_URL,
  resolveAuthConfig,
} from '../src/main/auth/config'

// resolveAuthConfig only touches `app` when reading the packaged package
// json, which these tests override via `pkg` — no electron mock needed.

describe('resolveAuthConfig', () => {
  it('falls back to the local-dev defaults when nothing is configured', () => {
    const config = resolveAuthConfig({ env: {}, isPackaged: false })
    expect(config).toEqual({
      issuer: DEV_AUTH_ISSUER,
      clientId: DEV_AUTH_CLIENT_ID,
      backendUrl: DEV_BACKEND_URL,
    })
  })

  it('reads the env override with the highest precedence', () => {
    const config = resolveAuthConfig({
      env: {
        GENOFFICE_AUTH_ISSUER: 'https://sso.example.com/realms/genoffice/',
        GENOFFICE_AUTH_CLIENT_ID: 'prod-client ',
        GENOFFICE_BACKEND_URL: 'https://api.example.com',
      },
      isPackaged: true,
      pkg: {
        genofficeAuth: { issuer: 'https://packaged.example.com', clientId: 'packaged-client' },
        genofficeBackend: { baseUrl: 'https://packaged-api.example.com' },
      },
    })
    expect(config).toEqual({
      issuer: 'https://sso.example.com/realms/genoffice', // trailing slash normalized
      clientId: 'prod-client', // trimmed
      backendUrl: 'https://api.example.com',
    })
  })

  it('reads the packaged extraMetadata when no env override is set', () => {
    const config = resolveAuthConfig({
      env: {},
      isPackaged: true,
      pkg: {
        genofficeAuth: {
          issuer: 'https://sso.example.com/realms/genoffice',
          clientId: 'prod-client',
        },
        genofficeBackend: { baseUrl: 'https://api.example.com' },
      },
    })
    expect(config).toEqual({
      issuer: 'https://sso.example.com/realms/genoffice',
      clientId: 'prod-client',
      backendUrl: 'https://api.example.com',
    })
  })

  it('never reads packaged metadata in a source build', () => {
    const config = resolveAuthConfig({
      env: {},
      isPackaged: false,
      pkg: {
        genofficeAuth: { issuer: 'https://sso.example.com', clientId: 'prod-client' },
        genofficeBackend: { baseUrl: 'https://api.example.com' },
      },
    })
    expect(config.issuer).toBe(DEV_AUTH_ISSUER)
    expect(config.clientId).toBe(DEV_AUTH_CLIENT_ID)
    expect(config.backendUrl).toBe(DEV_BACKEND_URL)
  })

  it('ignores invalid env values instead of adopting them', () => {
    const config = resolveAuthConfig({
      env: {
        GENOFFICE_AUTH_ISSUER: 'not a url',
        GENOFFICE_BACKEND_URL: 'ftp://nope.example.com',
      },
      isPackaged: false,
    })
    expect(config.issuer).toBe(DEV_AUTH_ISSUER)
    expect(config.backendUrl).toBe(DEV_BACKEND_URL)
  })

  it('rejects userinfo-bearing issuers', () => {
    const config = resolveAuthConfig({
      env: { GENOFFICE_AUTH_ISSUER: 'https://user:pass@sso.example.com' },
      isPackaged: false,
    })
    expect(config.issuer).toBe(DEV_AUTH_ISSUER)
  })

  it('returns a frozen object', () => {
    const config = resolveAuthConfig({ env: {}, isPackaged: false })
    expect(Object.isFrozen(config)).toBe(true)
  })
})
