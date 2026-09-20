/**
 * Cloud-auth session manager: the one owner of the login lifecycle state
 * between the raw `AuthOrchestrator` (packages/auth) and the IPC surface.
 *
 * Responsibilities (docs/cloud-backend-auth.md §B):
 * - restore the persisted session at startup (validating the stored id
 *   token's iss/aud/sub and the stored issuer before refreshing);
 * - drive device-flow logins, auto-opening the verification page through
 *   the origin-checked external-URL gate, and reporting progress as login
 *   events that never carry a URL or token;
 * - keep a proactive refresh timer armed at `exp − 30s` (min 5 s from now,
 *   re-armed after every refresh, cleared on logout, short retry backoff
 *   on transient network failures);
 * - broadcast session-changed whenever the session appears or leaves.
 *
 * Electron-free by injection (clock and browser opener are seams), so the
 * lifecycle is unit-testable without a main process.
 */

import {
  AuthError,
  AuthOrchestrator,
  decodeJwt,
  validateIdToken,
  type AuthSession,
  type FetchLike,
  type Sleep,
  type TokenStore,
} from '@genoffice/auth'
import { safeExternalUrl } from '@genoffice/electron-utils'
import type {
  AuthLoginEventPayload,
  AuthSessionChangedPayload,
  AuthSessionProfile,
  AuthSessionSnapshot,
} from '../../shared/auth-api'

/** Refresh this long before the access token's `exp` (design: exp − 30 s). */
const REFRESH_LEAD_MS = 30_000
/** Never schedule a refresh closer than this (races, tiny expires_in). */
const MIN_REFRESH_DELAY_MS = 5_000
/** Backoff for transient refresh failures so a flaky network drops no session. */
const REFRESH_RETRY_MS = 30_000

/**
 * Restore/refresh failures that mean the persisted credentials are dead
 * (AuthFlowError: server rejected or never issued them; TokenSetError /
 * TokenStoreError: the stored data fails validation). Everything else —
 * `network_error`, `http_error`, `invalid_response`, `cancelled`,
 * `io_error` — is transient: the store stays for a later retry.
 */
const TERMINAL_RESTORE_ERROR_CODES: ReadonlySet<string> = new Set([
  'not_logged_in',
  'refresh_failed',
  'invalid_jwt',
  'iss_mismatch',
  'aud_mismatch',
  'missing_sub',
  'corrupt_file',
])

export interface AuthSessionManagerOptions {
  /** resolved cloud-auth config (issuer + clientId) */
  config: { issuer: string; clientId: string }
  store: TokenStore
  /** live storage mode of the backing store (surfaced in the snapshot) */
  storageKind: () => AuthSessionSnapshot['storage']
  /** system-browser opener; only ever receives gate-approved URLs */
  openExternal: (url: string) => void
  /** epoch-ms clock (default Date.now) */
  now?: () => number
  /** transport seam forwarded to the orchestrator (default global fetch) */
  fetchFn?: FetchLike
  /** sleep seam forwarded to the orchestrator's token poller */
  sleep?: Sleep
}

/** Stable error code for the renderer — never a message (messages embed endpoint URLs). */
export function authErrorCode(error: unknown): string {
  return error instanceof AuthError ? error.code : 'unknown'
}

function realmRoles(idToken: string): string[] {
  try {
    const access = decodeJwt(idToken).payload['realm_access']
    if (access && typeof access === 'object' && !Array.isArray(access)) {
      const roles = (access as Record<string, unknown>)['roles']
      if (Array.isArray(roles))
        return roles.filter((role): role is string => typeof role === 'string')
    }
  } catch {
    // profile decoration only; a degenerate token must not break the snapshot
  }
  return []
}

function profileOf(session: AuthSession): AuthSessionProfile {
  const profile: AuthSessionProfile = {
    sub: session.profile.sub,
    roles: realmRoles(session.idToken),
  }
  if (session.profile.name) profile.name = session.profile.name
  if (session.profile.email) profile.email = session.profile.email
  return profile
}

export class AuthSessionManager {
  private readonly config: AuthSessionManagerOptions['config']
  private readonly store: TokenStore
  private readonly storageKind: () => AuthSessionSnapshot['storage']
  private readonly openExternal: (url: string) => void
  private readonly now: () => number
  private readonly orchestrator: AuthOrchestrator
  /** pre-parsed origin of the configured issuer — the external-URL gate */
  private readonly issuerOrigin: string

  /** live session (access + id tokens) — tracked by the manager alone */
  private current: AuthSession | undefined
  private refreshTimer: NodeJS.Timeout | undefined
  /**
   * The in-flight login pipeline. The orchestrator already single-flights
   * the attempt itself; keeping its promise here makes a joining
   * `startLogin()` await the same terminal result as the first caller.
   */
  private loginRun: Promise<void> | undefined
  /**
   * The waiting event of the in-flight attempt — replayed to subscribers
   * that join after it was emitted, so a late `auth:login` caller still
   * learns the user code it must display.
   */
  private pendingLoginEvent: AuthLoginEventPayload | undefined

  private readonly loginEventListeners = new Set<(payload: AuthLoginEventPayload) => void>()
  private readonly sessionChangedListeners = new Set<(payload: AuthSessionChangedPayload) => void>()

  constructor(options: AuthSessionManagerOptions) {
    this.config = options.config
    this.store = options.store
    this.storageKind = options.storageKind
    this.openExternal = options.openExternal
    this.now = options.now ?? (() => Date.now())
    this.orchestrator = new AuthOrchestrator({
      config: options.config,
      store: options.store,
      fetchFn: options.fetchFn,
      now: options.now,
      sleep: options.sleep,
    })
    let issuerUrl: URL
    try {
      issuerUrl = new URL(options.config.issuer)
    } catch {
      // config validation guarantees a parseable absolute http(s) URL; a
      // config bug should surface loudly, not silently skip the gate
      throw new Error(`Invalid auth issuer configured: ${options.config.issuer}`)
    }
    this.issuerOrigin = issuerUrl.origin
  }

  /** Subscribe to login progress; returns the unsubscribe. */
  onLoginEvent(listener: (payload: AuthLoginEventPayload) => void): () => void {
    this.loginEventListeners.add(listener)
    // a subscriber that joins mid-attempt (a second `auth:login` caller)
    // missed the waiting event — replay it once, to this listener only
    if (this.pendingLoginEvent !== undefined) {
      const pending = this.pendingLoginEvent
      try {
        listener(pending)
      } catch (error) {
        console.warn('[auth] login-event listener failed:', error)
      }
    }
    return () => this.loginEventListeners.delete(listener)
  }

  /** Subscribe to session changes; returns the unsubscribe. */
  onSessionChanged(listener: (payload: AuthSessionChangedPayload) => void): () => void {
    this.sessionChangedListeners.add(listener)
    return () => this.sessionChangedListeners.delete(listener)
  }

  /** Current session state for the renderer — profile only, never tokens. */
  snapshot(): AuthSessionSnapshot {
    return this.current === undefined
      ? { status: 'anonymous', storage: this.storageKind() }
      : {
          status: 'authenticated',
          profile: profileOf(this.current),
          storage: this.storageKind(),
        }
  }

  /**
   * Start (or join) the device-flow login. The verification page opens in
   * the system browser as soon as the device authorization response
   * arrives — design flow step 3 — and the renderer learns only the user
   * code and expiry. A joining caller awaits the same pipeline, so the
   * promise always settles at the terminal event (success/failure) — and
   * the pending waiting event is replayed to its subscription on join.
   */
  startLogin(): Promise<void> {
    if (this.loginRun !== undefined) return this.loginRun
    const run = this.runLogin()
    this.loginRun = run
    // runLogin never rejects (every failure becomes a login event)
    void run.then(() => {
      if (this.loginRun === run) this.loginRun = undefined
    })
    return run
  }

  private async runLogin(): Promise<void> {
    try {
      const handle = await this.orchestrator.startLogin()
      this.openIssuerUrl(handle.verificationUriComplete ?? handle.verificationUri)
      this.emitLoginEvent({
        status: 'waiting-for-confirmation',
        userCode: handle.userCode,
        expiresAt: handle.expiresAt,
      })
      try {
        this.adopt(await handle.tokens)
        this.emitLoginEvent({ status: 'success' })
        this.emitSessionChanged()
      } catch (error) {
        this.emitLoginEvent({ status: 'failure', error: authErrorCode(error) })
      }
    } catch (error) {
      // pre-poll failure (discovery / device authorization): no handle ever
      this.emitLoginEvent({ status: 'failure', error: authErrorCode(error) })
    }
  }

  /** Cancel the in-flight login; its pipeline reports `failure/cancelled`. */
  cancelLogin(): void {
    this.orchestrator.cancelLogin()
  }

  /**
   * Log out: revoke best-effort, wipe every local credential (guaranteed),
   * broadcast the change, then open the issuer's end-session page so the
   * SSO cookie clears — through the origin gate, and only after the local
   * wipe has completed.
   */
  async logout(): Promise<void> {
    this.clearRefreshTimer()
    this.current = undefined
    let endSessionUrl: string | undefined
    try {
      const result = await this.orchestrator.logout()
      endSessionUrl = result.endSessionUrl
    } catch (error) {
      // the orchestrator guarantees the wipe on every path; a failure here
      // is a store I/O error the user cannot act on — log and carry on
      console.warn('[auth] logout cleanup failed:', error)
    }
    this.emitSessionChanged()
    this.openIssuerUrl(endSessionUrl)
  }

  /**
   * Startup restore. A stored set is only trusted after its issuer matches
   * the configured one and its id token passes the iss/aud/sub checks;
   * `refresh()` then mints the live session. Terminal failures (revoked or
   * absent refresh token, unusable stored data) wipe the store; transient
   * network failures leave the app logged out without touching it.
   */
  async restore(): Promise<void> {
    try {
      const stored = await this.store.load()
      if (stored === null) return
      if (stored.issuer !== this.config.issuer) {
        // credentials minted by another issuer deployment (config switch):
        // unusable here, and keeping them would resurrect a foreign session
        await this.clearStored('stored credentials belong to a different issuer')
        return
      }
      validateIdToken(stored.idToken, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
      })
      this.adopt(await this.orchestrator.refresh())
      this.emitSessionChanged()
    } catch (error) {
      if (this.isTerminalAuthError(error)) {
        await this.clearStored('stored credentials are no longer usable')
        this.current = undefined
        this.clearRefreshTimer()
        return
      }
      // transient (network/proxy/http): stay silently logged out — the next
      // launch or an explicit login retries
      console.warn('[auth] session restore failed:', error)
    }
  }

  /**
   * Errors for which the stored credentials are dead (wipe + stay logged
   * out) as opposed to transient transport failures (keep the store; the
   * next launch or explicit login retries). `io_error` is deliberately on
   * the transient side — a full disk must not destroy the credentials.
   */
  private isTerminalAuthError(error: unknown): boolean {
    return error instanceof AuthError && TERMINAL_RESTORE_ERROR_CODES.has(error.code)
  }

  /**
   * Wipe via the orchestrator (cancels in-flight work, revokes best-effort,
   * clears the store) — used while a session is live, where in-flight
   * login/refresh work must be neutralized too.
   */
  private async wipeQuietly(reason: string): Promise<void> {
    console.warn(`[auth] ${reason}; clearing the stored session`)
    await this.orchestrator.logout().catch((error: unknown) => {
      console.warn('[auth] clearing the stored session failed:', error)
    })
  }

  /** Restore-time wipe: nothing is in flight yet, so no network, just the file. */
  private async clearStored(reason: string): Promise<void> {
    console.warn(`[auth] ${reason}; clearing the stored session`)
    await this.store.clear().catch((error: unknown) => {
      console.warn('[auth] clearing the stored session failed:', error)
    })
  }

  private adopt(session: AuthSession): void {
    this.current = session
    this.armRefreshTimer(session)
  }

  private armRefreshTimer(session: AuthSession): void {
    this.clearRefreshTimer()
    const expiresAt = session.accessTokenExpiresAt
    if (expiresAt === undefined) return
    const delay = Math.max(expiresAt - REFRESH_LEAD_MS - this.now(), MIN_REFRESH_DELAY_MS)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refreshProactively()
    }, delay)
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }

  private async refreshProactively(): Promise<void> {
    try {
      this.adopt(await this.orchestrator.refresh())
    } catch (error) {
      if (error instanceof AuthError && error.code === 'cancelled') return
      if (this.isTerminalAuthError(error)) {
        // the refresh token died while the app ran: local logout + broadcast
        this.current = undefined
        await this.wipeQuietly('the refresh token was rejected')
        this.emitSessionChanged()
        return
      }
      // transient failure: retry shortly so the session survives a blip
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined
        void this.refreshProactively()
      }, REFRESH_RETRY_MS)
    }
  }

  /**
   * Open a verification/end-session URL only when it parses, is http(s),
   * and its origin is exactly the configured issuer's — anything else
   * (compromised discovery response, malformed endpoint) is dropped.
   */
  private openIssuerUrl(url: string | undefined): void {
    if (url === undefined) return
    const approved = safeExternalUrl(url, { allowedOrigins: [this.issuerOrigin] })
    if (approved === null) {
      console.warn('[auth] refused to open a URL outside the configured issuer origin')
      return
    }
    this.openExternal(approved)
  }

  private emitLoginEvent(payload: AuthLoginEventPayload): void {
    // keep the join-replay cache in step: waiting state is replayable, a
    // terminal event ends the attempt and must not be replayed
    this.pendingLoginEvent = payload.status === 'waiting-for-confirmation' ? payload : undefined
    for (const listener of [...this.loginEventListeners]) {
      try {
        listener(payload)
      } catch (error) {
        console.warn('[auth] login-event listener failed:', error)
      }
    }
  }

  private emitSessionChanged(): void {
    const payload: AuthSessionChangedPayload = {
      status: this.current === undefined ? 'anonymous' : 'authenticated',
    }
    for (const listener of [...this.sessionChangedListeners]) {
      try {
        listener(payload)
      } catch (error) {
        console.warn('[auth] session-changed listener failed:', error)
      }
    }
  }
}
