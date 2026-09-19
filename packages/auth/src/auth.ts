/**
 * Auth orchestrator — the device-grant login lifecycle in one place.
 *
 * Composes the discovery client, the device-authorization request, the token
 * poller, and the token store into the four operations the shell drives:
 *
 * - `startLogin()` — discovery → device-auth request → resolves with the
 *   display info (`user_code`, verification URIs, expiry) plus the promise
 *   that settles once the user approves and the validated session has been
 *   persisted;
 * - `cancelLogin()` — cancels the in-flight attempt;
 * - `refresh()` — exchanges the refresh token for a fresh access/id set
 *   (loading the stored set first when there is no in-memory session, which
 *   is the restart/restore path);
 * - `logout()` — revokes the refresh token (best-effort), constructs the
 *   end-session URL with `id_token_hint` for the caller to open, and wipes
 *   every local credential (the wipe is guaranteed, whatever the network
 *   does).
 *
 * Token discipline: the access/id tokens and the refresh token live in
 * memory only; the refresh token reaches disk exclusively through the
 * injected {@link TokenStore}; the `device_code` never leaves the poll
 * pipeline — it is not persisted and never appears in an error message.
 *
 * Pure logic, no Electron: transport, clock, and sleep are injectable, so
 * tests drive the whole flow against mocked endpoints.
 */

import { requestDeviceAuthorization } from './device-auth.js'
import { DiscoveryClient } from './discovery.js'
import { AuthFlowError } from './errors.js'
import { startDeviceTokenPoll } from './token-poller.js'
import { parseTokenResponse, validateIdToken } from './token-set.js'
import type {
  AuthConfig,
  AuthOrchestratorOptions,
  AuthSession,
  Clock,
  DeviceTokenPollHandle,
  FetchLike,
  IdTokenClaims,
  LoginHandle,
  LogoutResult,
  Sleep,
  TokenSet,
  TokenStore,
  UserProfile,
} from './types.js'

/** Scope requested unless the config overrides it (design: openid profile email offline_access) */
const DEFAULT_SCOPE = 'openid profile email offline_access'

/** RFC 6749 §6 refresh grant type */
const REFRESH_GRANT_TYPE = 'refresh_token'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formHeaders(): Record<string, string> {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
}

/**
 * Best-effort extraction of the OAuth `error` field from a non-2xx body —
 * `undefined` when the body is unreadable or carries no error code.
 */
async function readOAuthErrorCode(response: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await response.text())
    if (!isRecord(parsed)) return undefined
    const error = parsed['error']
    return typeof error === 'string' && error.length > 0 ? error : undefined
  } catch {
    return undefined
  }
}

/** Profile snapshot from validated id-token claims (snake_case → camelCase) */
function profileFromClaims(claims: IdTokenClaims): UserProfile {
  const pick = (claim: string): string | undefined => {
    const value = claims[claim]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  return {
    sub: claims.sub,
    name: pick('name'),
    email: pick('email'),
    preferredUsername: pick('preferred_username'),
  }
}

/** An in-flight login attempt (single-flight slot) */
interface LoginAttempt {
  /** Resolves with the handle once the device-authorization response arrives */
  handlePromise: Promise<LoginHandle>
  /** Session promise behind `handle.tokens`; settling it frees the slot */
  tokensPromise: Promise<AuthSession>
  /** Cancels the attempt wherever it currently is; idempotent */
  cancel(): void
}

export class AuthOrchestrator {
  private readonly config: AuthConfig
  private readonly store: TokenStore
  private readonly fetchFn: FetchLike
  private readonly now: Clock
  private readonly sleep: Sleep
  private readonly discovery: DiscoveryClient

  /** Live session (access + id tokens) — memory only */
  private session: AuthSession | undefined
  /** Current refresh token — memory only, persisted via the store alone */
  private refreshToken: string | undefined
  private loginAttempt: LoginAttempt | undefined
  private refreshInFlight: Promise<AuthSession> | undefined
  /**
   * Credential generation, bumped by every `logout()`. In-flight logins and
   * refreshes capture it before their last await and compare before adopting
   * credentials — an attempt that completes after a logout started is
   * discarded instead of re-adopting a session and re-saving credentials
   * over the wipe.
   */
  private generation = 0

  constructor(options: AuthOrchestratorOptions) {
    this.config = options.config
    this.store = options.store
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.discovery = new DiscoveryClient({
      issuer: options.config.issuer,
      fetchFn: this.fetchFn,
      now: this.now,
    })
  }

  /** Audience the id-token `aud` check uses: explicit or the client_id */
  private get audience(): string {
    return this.config.audience ?? this.config.clientId
  }

  /**
   * Start a device-grant login. Resolves as soon as the device authorization
   * response arrives, with the display info (`userCode`,
   * `verificationUri(Complete)` — main-process data — and `expiresAt`) plus
   * `tokens`, the promise for the validated, persisted session.
   *
   * Single-flight: while an attempt is in flight (from the first call until
   * its `tokens` settle), every further call **joins** — it resolves with
   * the very same handle and no second device request is made.
   *
   * `tokens` rejects with the poller's typed errors (`access_denied`,
   * `expired_token`, `poll_expired`, `cancelled`, …) or an `AuthFlowError`
   * (`missing_endpoint`, `invalid_response`, …) for pre-poll failures; in
   * those pre-poll cases the handle promise itself rejects.
   */
  startLogin(): Promise<LoginHandle> {
    const existing = this.loginAttempt
    if (existing) return existing.handlePromise

    let cancelled = false
    let poll: DeviceTokenPollHandle | undefined
    let resolveHandle!: (handle: LoginHandle) => void
    let rejectHandle!: (error: unknown) => void
    const handlePromise = new Promise<LoginHandle>((resolve, reject) => {
      resolveHandle = resolve
      rejectHandle = reject
    })
    let resolveTokens!: (session: AuthSession) => void
    let rejectTokens!: (error: unknown) => void
    const tokensPromise = new Promise<AuthSession>((resolve, reject) => {
      resolveTokens = resolve
      rejectTokens = reject
    })

    const attempt: LoginAttempt = {
      handlePromise,
      tokensPromise,
      cancel: (): void => {
        if (this.loginAttempt !== attempt || cancelled) return
        cancelled = true
        if (poll) {
          // Settled poll → no-op (delegates to the poller's own semantics);
          // in flight → rejects the pipeline with its typed `cancelled`.
          poll.cancel()
        } else {
          // Pre-poll: the pipeline is parked on discovery/device-auth and
          // only the flag can stop it.
          const error = new AuthFlowError('Device login was cancelled', { code: 'cancelled' })
          rejectHandle(error)
          rejectTokens(error)
        }
      },
    }
    this.loginAttempt = attempt
    // Free the single-flight slot when tokens settle; this also marks
    // tokensPromise handled for the window where no handle was delivered.
    void tokensPromise.then(
      () => this.releaseLogin(attempt),
      () => this.releaseLogin(attempt),
    )

    void (async (): Promise<void> => {
      const generation = this.generation
      try {
        const document = await this.discovery.get()
        if (cancelled) throw cancelError()
        if (document.deviceAuthorizationEndpoint === undefined) {
          throw new AuthFlowError(
            `Discovery document from ${this.config.issuer} has no device_authorization_endpoint`,
            { code: 'missing_endpoint' },
          )
        }

        const device = await requestDeviceAuthorization({
          endpoint: document.deviceAuthorizationEndpoint,
          clientId: this.config.clientId,
          scope: this.config.scope ?? DEFAULT_SCOPE,
          fetchFn: this.fetchFn,
        })
        if (cancelled) throw cancelError()

        poll = startDeviceTokenPoll({
          endpoint: document.tokenEndpoint,
          clientId: this.config.clientId,
          deviceCode: device.deviceCode,
          expiresIn: device.expiresIn,
          interval: device.interval,
          fetchFn: this.fetchFn,
          now: this.now,
          sleep: this.sleep,
        })

        resolveHandle({
          userCode: device.userCode,
          verificationUri: device.verificationUri,
          verificationUriComplete: device.verificationUriComplete,
          expiresAt: this.now() + device.expiresIn * 1000,
          tokens: tokensPromise,
          cancel: () => this.cancelLogin(),
        })

        const tokenSet = await poll.promise
        // A logout while the poll was settling invalidates this attempt
        if (this.generation !== generation) throw cancelError()
        resolveTokens(await this.applyTokenSet(tokenSet, document.issuer))
      } catch (error) {
        // Pre-handle failures reject the handle promise too; once the handle
        // was delivered these settles are no-ops.
        rejectHandle(error)
        rejectTokens(error)
      }
    })()

    return handlePromise
  }

  private releaseLogin(attempt: LoginAttempt): void {
    if (this.loginAttempt === attempt) this.loginAttempt = undefined
  }

  /** Cancel the in-flight login attempt, if any (idempotent no-op otherwise). */
  cancelLogin(): void {
    this.loginAttempt?.cancel()
  }

  /**
   * Exchange the refresh token for a fresh access/id token set, rotating the
   * stored refresh token when the server sends a new one. With no in-memory
   * session the stored set is loaded first — the restore path after an app
   * restart.
   *
   * Single-flight: concurrent calls share the very same promise (one token
   * request). Throws `AuthFlowError`: `not_logged_in` when no session and no
   * stored set exist, `refresh_failed` when the server rejects the refresh
   * token (expired/revoked — re-login required), plus `http_error` /
   * `network_error` / `invalid_response` for transport and shape failures.
   */
  refresh(): Promise<AuthSession> {
    const inFlight = this.refreshInFlight
    if (inFlight) return inFlight
    this.refreshInFlight = this.runRefresh().finally(() => {
      this.refreshInFlight = undefined
    })
    return this.refreshInFlight
  }

  private async runRefresh(): Promise<AuthSession> {
    const generation = this.generation
    let refreshToken = this.refreshToken
    let previous: { idToken?: string; profile?: UserProfile } = {}
    if (refreshToken === undefined) {
      const stored = await this.store.load()
      if (stored === null) {
        throw new AuthFlowError('No session or stored credentials to refresh', {
          code: 'not_logged_in',
        })
      }
      refreshToken = stored.refreshToken
      previous = { idToken: stored.idToken, profile: stored.profile }
    } else if (this.session !== undefined) {
      previous = { idToken: this.session.idToken, profile: this.session.profile }
    }

    const document = await this.discovery.get()

    const body = new URLSearchParams({
      grant_type: REFRESH_GRANT_TYPE,
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    }).toString()
    let response: Response
    try {
      response = await this.fetchFn(document.tokenEndpoint, {
        method: 'POST',
        headers: formHeaders(),
        body,
      })
    } catch (cause) {
      throw new AuthFlowError(
        `Token request to ${document.tokenEndpoint} failed at the network layer`,
        { code: 'network_error', cause },
      )
    }

    if (!response.ok) {
      const oauthError = await readOAuthErrorCode(response)
      if (oauthError === 'invalid_grant') {
        throw new AuthFlowError('The refresh token was rejected (invalid_grant)', {
          code: 'refresh_failed',
          status: response.status,
        })
      }
      const detail = oauthError ? ` (${oauthError})` : ''
      throw new AuthFlowError(`Token request returned HTTP ${response.status}${detail}`, {
        code: 'http_error',
        status: response.status,
      })
    }

    let tokenSet: TokenSet
    try {
      tokenSet = parseTokenResponse(await response.text())
    } catch (cause) {
      throw new AuthFlowError('Token endpoint returned a malformed success payload', {
        code: 'invalid_response',
        cause,
      })
    }
    // A logout while the request was in flight invalidates this refresh
    if (this.generation !== generation) {
      throw new AuthFlowError('The refresh was cancelled by a logout', { code: 'cancelled' })
    }
    return this.applyTokenSet(tokenSet, document.issuer, previous)
  }

  /**
   * Log out. Revokes the refresh token at the discovery-provided revocation
   * endpoint (`token_type_hint=refresh_token`), constructs the end-session
   * URL with `id_token_hint` for the caller to open — core never opens
   * anything — and wipes the session, the in-memory refresh token, and the
   * store.
   *
   * In-flight work is neutralized first: a pending login poll is cancelled,
   * and the generation bump makes any login/refresh that is already past
   * its last await discard its result, so no credential can be re-adopted
   * or re-saved after the wipe.
   *
   * Revocation and discovery are best-effort (a network outage or a 500 from
   * the revocation endpoint still logs the user out locally); the local wipe
   * is guaranteed and runs on every path. `endSessionUrl` is `undefined`
   * when no end-session endpoint is advertised or no id token is available
   * for the hint.
   */
  async logout(): Promise<LogoutResult> {
    // Synchronous, before the first await: everything below takes turns on
    // the event loop, and an in-flight attempt must not slip past the wipe.
    this.cancelLogin()
    this.generation += 1
    try {
      let refreshToken = this.refreshToken
      let idToken = this.session?.idToken
      if (refreshToken === undefined || idToken === undefined) {
        // Restart case: the credentials live in the store
        const stored = await this.store.load().catch(() => null)
        if (stored !== null) {
          refreshToken ??= stored.refreshToken
          idToken ??= stored.idToken
        }
      }

      let endSessionUrl: string | undefined
      if (refreshToken !== undefined || idToken !== undefined) {
        const document = await this.discovery.get().catch(() => undefined)
        if (document !== undefined) {
          if (refreshToken !== undefined && document.revocationEndpoint !== undefined) {
            await this.revoke(document.revocationEndpoint, refreshToken).catch(() => undefined)
          }
          if (document.endSessionEndpoint !== undefined && idToken !== undefined) {
            endSessionUrl = this.buildEndSessionUrl(document.endSessionEndpoint, idToken)
          }
        }
      }
      return { endSessionUrl }
    } finally {
      this.session = undefined
      this.refreshToken = undefined
      await this.store.clear()
    }
  }

  /** POST the refresh token to the revocation endpoint (RFC 7009). */
  private async revoke(endpoint: string, refreshToken: string): Promise<void> {
    const body = new URLSearchParams({
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: this.config.clientId,
    }).toString()
    let response: Response
    try {
      response = await this.fetchFn(endpoint, { method: 'POST', headers: formHeaders(), body })
    } catch (cause) {
      throw new AuthFlowError(`Revocation request to ${endpoint} failed at the network layer`, {
        code: 'network_error',
        cause,
      })
    }
    if (!response.ok) {
      throw new AuthFlowError(`Revocation request returned HTTP ${response.status}`, {
        code: 'http_error',
        status: response.status,
      })
    }
  }

  /** Construct `end_session_endpoint?id_token_hint=…` — validation against the configured issuer stays with the caller. */
  private buildEndSessionUrl(endpoint: string, idTokenHint: string): string {
    let url: URL
    try {
      url = new URL(endpoint)
    } catch (cause) {
      throw new AuthFlowError(`End-session endpoint "${endpoint}" is not an absolute URL`, {
        code: 'invalid_url',
        cause,
      })
    }
    url.searchParams.set('id_token_hint', idTokenHint)
    return url.toString()
  }

  /**
   * Validate a fresh token set, adopt it as the in-memory session, and
   * persist refresh + id tokens. The id-token claims (iss/aud/sub) are
   * checked whenever the response carries an id token; otherwise the
   * previous id token/profile carry over (refresh responses may omit the
   * id token). A response with neither a new nor a previous id token is a
   * shape failure. Without a refresh token the login stays session-only and
   * nothing is written to the store.
   */
  private async applyTokenSet(
    tokenSet: TokenSet,
    issuer: string,
    previous: { idToken?: string; profile?: UserProfile } = {},
  ): Promise<AuthSession> {
    let idToken: string
    let profile: UserProfile
    if (tokenSet.idToken !== undefined) {
      idToken = tokenSet.idToken
      profile = profileFromClaims(
        validateIdToken(tokenSet.idToken, { issuer, audience: this.audience }),
      )
    } else if (previous.idToken !== undefined && previous.profile !== undefined) {
      idToken = previous.idToken
      profile = previous.profile
    } else {
      throw new AuthFlowError('Token response carried no id_token', { code: 'invalid_response' })
    }

    const obtainedAt = this.now()
    const refreshToken = tokenSet.refreshToken ?? this.refreshToken
    const session: AuthSession = {
      accessToken: tokenSet.accessToken,
      idToken,
      profile,
      obtainedAt,
      accessTokenExpiresAt:
        tokenSet.expiresIn !== undefined ? obtainedAt + tokenSet.expiresIn * 1000 : undefined,
    }
    this.session = session
    this.refreshToken = refreshToken
    if (refreshToken !== undefined) {
      await this.store.save({ refreshToken, idToken, profile, obtainedAt, issuer })
    }
    return session
  }
}

function cancelError(): AuthFlowError {
  return new AuthFlowError('Device login was cancelled', { code: 'cancelled' })
}
