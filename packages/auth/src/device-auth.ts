/**
 * RFC 8628 device authorization grant — initial request.
 *
 * POSTs `client_id` (and `scope`, when given) to the discovery-provided
 * `device_authorization_endpoint` and parses `device_code` / `user_code` /
 * `verification_uri(_complete)` / `expires_in` / `interval`. The
 * `device_code` is a secret: it stays in the returned object (in memory),
 * and never appears in error messages or logs.
 */

import { DeviceAuthError } from './errors.js'
import type { DeviceAuthorizationRequest, DeviceAuthorizationResponse, FetchLike } from './types.js'

/** RFC 8628 §3.2: polling interval when the server does not specify one */
const DEFAULT_INTERVAL_SECONDS = 5

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(doc: Record<string, unknown>, field: string): string {
  const value = doc[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new DeviceAuthError(`Device authorization field "${field}" is missing or not a string`, {
      code: 'invalid_response',
    })
  }
  return value
}

function optionalString(doc: Record<string, unknown>, field: string): string | undefined {
  const value = doc[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requirePositiveNumber(doc: Record<string, unknown>, field: string): number {
  const value = doc[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new DeviceAuthError(`Device authorization field "${field}" is not a positive number`, {
      code: 'invalid_response',
    })
  }
  return value
}

function optionalPositiveNumber(doc: Record<string, unknown>, field: string): number | undefined {
  const value = doc[field]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Best-effort extraction of the OAuth `error` / `error_description` fields
 * from a non-2xx response body, for the error message only — failures to
 * read it degrade to the bare status line.
 */
async function oauthErrorDetail(response: Response): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await response.text())
    if (!isRecord(parsed)) return ''
    const error = optionalString(parsed, 'error')
    const description = optionalString(parsed, 'error_description')
    if (error && description) return ` (${error}: ${description})`
    if (error) return ` (${error})`
    if (description) return `: ${description}`
    return ''
  } catch {
    return ''
  }
}

/**
 * Request a device authorization grant. Everything arrives via the plain
 * `request` object (endpoint, clientId, scope, injectable fetch) — no
 * ambient state. Throws `DeviceAuthError` on non-2xx, transport, and
 * response-shape failures.
 */
export async function requestDeviceAuthorization(
  request: DeviceAuthorizationRequest,
): Promise<DeviceAuthorizationResponse> {
  const body = new URLSearchParams()
  body.set('client_id', request.clientId)
  if (request.scope) body.set('scope', request.scope)

  const fetchFn: FetchLike = request.fetchFn ?? ((url, init) => fetch(url, init))
  let response: Response
  try {
    response = await fetchFn(request.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (cause) {
    throw new DeviceAuthError(
      `Device authorization request to ${request.endpoint} failed at the network layer`,
      { code: 'network_error', cause },
    )
  }

  if (!response.ok) {
    const detail = await oauthErrorDetail(response)
    throw new DeviceAuthError(
      `Device authorization request returned HTTP ${response.status}${detail}`,
      { code: 'http_error', status: response.status },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await response.text())
  } catch (cause) {
    throw new DeviceAuthError('Device authorization response is not valid JSON', {
      code: 'invalid_response',
      cause,
    })
  }
  if (!isRecord(parsed)) {
    throw new DeviceAuthError('Device authorization response is not a JSON object', {
      code: 'invalid_response',
    })
  }

  return {
    deviceCode: requireString(parsed, 'device_code'),
    userCode: requireString(parsed, 'user_code'),
    verificationUri: requireString(parsed, 'verification_uri'),
    verificationUriComplete: optionalString(parsed, 'verification_uri_complete'),
    expiresIn: requirePositiveNumber(parsed, 'expires_in'),
    interval: optionalPositiveNumber(parsed, 'interval') ?? DEFAULT_INTERVAL_SECONDS,
  }
}
