/**
 * OIDC discovery client.
 *
 * Fetches `<issuer>/.well-known/openid-configuration`, validates the
 * endpoint fields the suite relies on, and caches the parsed document with
 * a TTL — a fresh `get()` re-fetches on expiry. The HTTP transport and the
 * clock are injectable so tests mock by injection, never over the network.
 */

import { DiscoveryError } from './errors.js'
import type { Clock, DiscoveryClientOptions, DiscoveryDocument, FetchLike } from './types.js'

/** Default cache TTL: 5 minutes */
const DEFAULT_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  document: DiscoveryDocument
  fetchedAt: number
}

/** Strip trailing slashes so the issuer always composes into one well-known URL */
function wellKnownUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(doc: Record<string, unknown>, field: string): string {
  const value = doc[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new DiscoveryError(`Discovery document field "${field}" is missing or not a string`, {
      code: 'invalid_document',
    })
  }
  return value
}

function optionalString(doc: Record<string, unknown>, field: string): string | undefined {
  const value = doc[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Validate and map a raw discovery payload. Throws `DiscoveryError`
 * (code `invalid_document`) on non-JSON bodies and on missing/ill-typed
 * required fields.
 */
export function parseDiscoveryDocument(raw: string): DiscoveryDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new DiscoveryError('Discovery response is not valid JSON', {
      code: 'invalid_document',
      cause,
    })
  }
  if (!isRecord(parsed)) {
    throw new DiscoveryError('Discovery response is not a JSON object', {
      code: 'invalid_document',
    })
  }
  return {
    issuer: requireString(parsed, 'issuer'),
    authorizationEndpoint: requireString(parsed, 'authorization_endpoint'),
    tokenEndpoint: requireString(parsed, 'token_endpoint'),
    deviceAuthorizationEndpoint: optionalString(parsed, 'device_authorization_endpoint'),
    revocationEndpoint: optionalString(parsed, 'revocation_endpoint'),
    endSessionEndpoint: optionalString(parsed, 'end_session_endpoint'),
  }
}

export class DiscoveryClient {
  private readonly issuer: string
  private readonly ttlMs: number
  private readonly fetchFn: FetchLike
  private readonly now: Clock
  private cache: CacheEntry | undefined

  constructor(options: DiscoveryClientOptions) {
    this.issuer = options.issuer
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * The cached document when present and unexpired; `undefined` otherwise.
   * Performs no I/O.
   */
  getCached(): DiscoveryDocument | undefined {
    const entry = this.cache
    if (!entry || this.now() - entry.fetchedAt >= this.ttlMs) return undefined
    return entry.document
  }

  /**
   * The discovery document, served from cache while fresh and re-fetched
   * on expiry. A failed fetch leaves any prior cache entry untouched.
   */
  async get(): Promise<DiscoveryDocument> {
    const cached = this.getCached()
    if (cached) return cached

    const url = wellKnownUrl(this.issuer)
    let response: Response
    try {
      response = await this.fetchFn(url, { headers: { accept: 'application/json' } })
    } catch (cause) {
      throw new DiscoveryError(`Discovery request to ${url} failed at the network layer`, {
        code: 'network_error',
        cause,
      })
    }
    if (!response.ok) {
      throw new DiscoveryError(`Discovery request to ${url} returned HTTP ${response.status}`, {
        code: 'http_error',
        status: response.status,
      })
    }

    const document = parseDiscoveryDocument(await response.text())
    this.cache = { document, fetchedAt: this.now() }
    return document
  }
}
