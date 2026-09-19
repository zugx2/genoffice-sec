/**
 * RFC 8628 §3.4/§3.5 — polling the token endpoint of a device grant.
 *
 * `startDeviceTokenPoll` POSTs `grant_type=urn:ietf:params:oauth:grant-type:device_code`
 * with the `device_code` and `client_id` every `interval` seconds, treating
 * `authorization_pending` as keep-going, `slow_down` as "increase the
 * interval by 5 s over the current interval (and keep the new cadence)",
 * and `access_denied` / `expired_token` as terminal. It also stops on its
 * own when `expires_in` elapses, and is cancellable at any time.
 *
 * The `device_code` is a secret redeemable for tokens once approved: it is
 * sent to the token endpoint and otherwise stays in memory — it never
 * appears in an error message, and this module never logs.
 *
 * Time and transport are injectable: `sleep` (default: a real
 * `setTimeout` promise), `now` (default: `Date.now`), and `fetchFn`
 * (default: global fetch), so tests drive everything deterministically.
 */

import { TokenPollError } from './errors.js'
import { parseTokenResponse } from './token-set.js'
import type { Clock, DeviceTokenPollHandle, DeviceTokenPollOptions, FetchLike, Sleep, TokenSet } from './types.js'

/** RFC 8628 §3.4 device grant type identifier */
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** RFC 8628 §3.5: polling interval when the device authorization response omits it */
const DEFAULT_INTERVAL_SECONDS = 5

/** RFC 8628 §3.5: a slow_down response adds 5 s to the current interval */
const SLOW_DOWN_INCREMENT_SECONDS = 5

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Best-effort extraction of the OAuth `error` field from a non-2xx body —
 * `undefined` when the body is unreadable or carries no error code.
 */
async function readOAuthError(response: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await response.text())
    if (!isRecord(parsed)) return undefined
    const error = parsed['error']
    return typeof error === 'string' && error.length > 0 ? error : undefined
  } catch {
    return undefined
  }
}

/**
 * Start polling for the device-grant token set. Returns a handle:
 *
 * - `promise` resolves with the parsed {@link TokenSet} once the user
 *   approves, and rejects with a `TokenPollError` on every terminal
 *   condition: `access_denied`, `expired_token`, `poll_expired` (the
 *   device authorization `expires_in` elapsed), `cancelled`,
 *   `http_error` (non-2xx with an unknown/absent OAuth error — a
 *   transport-level failure of the token endpoint is not retryable here),
 *   `network_error`, and `invalid_response` (malformed success body).
 * - `cancel()` stops polling immediately — including while a sleep is in
 *   flight — and rejects the promise with a `cancelled` error. It is
 *   idempotent and a no-op once the promise has settled.
 *
 * The first poll fires immediately; subsequent polls follow the
 * (possibly `slow_down`-lengthened) interval.
 */
export function startDeviceTokenPoll(options: DeviceTokenPollOptions): DeviceTokenPollHandle {
  const fetchFn: FetchLike = options.fetchFn ?? ((url, init) => fetch(url, init))
  const now: Clock = options.now ?? (() => Date.now())
  const sleep: Sleep = options.sleep ?? defaultSleep

  const body = new URLSearchParams({
    grant_type: DEVICE_GRANT_TYPE,
    device_code: options.deviceCode,
    client_id: options.clientId,
  }).toString()

  let cancelled = false
  let resolvePromise!: (tokenSet: TokenSet) => void
  let rejectPromise!: (error: TokenPollError) => void

  const promise = new Promise<TokenSet>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
    // Safety net: run() maps every expected failure itself, but a bug must
    // not leave the promise dangling.
    run().catch(reject)
  })

  async function run(): Promise<void> {
    const deadline = now() + options.expiresIn * 1000
    let intervalMs = Math.max(1, options.interval ?? DEFAULT_INTERVAL_SECONDS) * 1000

    for (;;) {
      let response: Response
      try {
        response = await fetchFn(options.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body,
        })
      } catch (cause) {
        rejectPromise(
          new TokenPollError(`Token request to ${options.endpoint} failed at the network layer`, {
            code: 'network_error',
            cause,
          }),
        )
        return
      }

      if (response.ok) {
        try {
          resolvePromise(parseTokenResponse(await response.text()))
        } catch (cause) {
          rejectPromise(
            new TokenPollError('Token endpoint returned a malformed success payload', {
              code: 'invalid_response',
              cause,
            }),
          )
        }
        return
      }

      const oauthError = await readOAuthError(response)
      if (oauthError === 'authorization_pending') {
        // keep going at the current interval
      } else if (oauthError === 'slow_down') {
        intervalMs += SLOW_DOWN_INCREMENT_SECONDS * 1000
      } else if (oauthError === 'access_denied') {
        rejectPromise(
          new TokenPollError('The user denied the device authorization request', {
            code: 'access_denied',
            status: response.status,
          }),
        )
        return
      } else if (oauthError === 'expired_token') {
        rejectPromise(
          new TokenPollError('The device_code expired before authorization completed', {
            code: 'expired_token',
            status: response.status,
          }),
        )
        return
      } else {
        const detail = oauthError ? ` (${oauthError})` : ''
        rejectPromise(
          new TokenPollError(`Token request returned HTTP ${response.status}${detail}`, {
            code: 'http_error',
            status: response.status,
          }),
        )
        return
      }

      if (cancelled) return
      await sleep(intervalMs)
      if (cancelled) return
      if (now() >= deadline) {
        rejectPromise(
          new TokenPollError('The device authorization expires_in elapsed before approval completed', {
            code: 'poll_expired',
          }),
        )
        return
      }
    }
  }

  return {
    promise,
    cancel() {
      if (cancelled) return
      cancelled = true
      rejectPromise(
        new TokenPollError('Device token polling was cancelled', { code: 'cancelled' }),
      )
    },
  }
}
