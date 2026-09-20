/**
 * Cloud-auth IPC contract between the shell main process and (from Phase 3
 * on) the preload/renderer. Channel names plus the exact wire payload types.
 *
 * Security invariants (docs/cloud-backend-auth.md, security checklist):
 * - the renderer NEVER receives tokens (access/refresh/id), the device code,
 *   or endpoint URLs — only the session profile below and login progress;
 * - every payload crossing these channels is zod-validated in the main
 *   process (apps/shell/src/main/auth/ipc.ts, following the sheets IPC
 *   precedent).
 */

export const AUTH_CHANNELS = {
  /** start (or join) the device-authorization-grant login */
  login: 'auth:login',
  /** cancel the in-flight login attempt */
  cancelLogin: 'auth:cancel-login',
  /** revoke + wipe + open the issuer's end-session page */
  logout: 'auth:logout',
  /** current session snapshot (profile only, never tokens) */
  getSession: 'auth:get-session',
  /** push: login progress, streamed to the renderer that started the login */
  loginEvent: 'auth:login-event',
  /** push: broadcast to every webContents when the session appears/leaves */
  sessionChanged: 'auth:session-changed',
  /** re-open the in-flight login's verification page (main-side URL only) */
  openVerificationPage: 'auth:open-verification-page',
} as const

/**
 * Login progress pushed over `auth:login-event`. Mirrors the
 * `home:account-login-event` progress pattern but never carries a URL: the
 * main process alone opens the verification page (origin-checked against
 * the configured issuer), the renderer only shows the user code.
 */
export type AuthLoginEventPayload =
  | {
      /** the device code was issued; waiting for the user to approve it */
      status: 'waiting-for-confirmation'
      /** shown verbatim (no reformatting) — the anti-phishing comparison step */
      userCode: string
      /** epoch ms when the device code expires */
      expiresAt: number
    }
  | { status: 'success' }
  | {
      status: 'failure'
      /** stable auth error code (`network_error`, `access_denied`, …) — never a raw message, which can embed endpoint URLs */
      error: string
    }

/** Session profile decoded from the id token — the token itself never crosses. */
export interface AuthSessionProfile {
  sub: string
  name?: string
  email?: string
  /** realm roles from the id token's `realm_access.roles` (empty when absent) */
  roles: string[]
}

/** How the refresh-token file is protected on this machine. */
export type AuthStorageKind = 'encrypted' | 'plain-file'

/** Response of `auth:get-session`. */
export interface AuthSessionSnapshot {
  status: 'authenticated' | 'anonymous'
  profile?: AuthSessionProfile
  /** `'plain-file'` means safeStorage/keyring is unavailable — Phase 3 warns */
  storage: AuthStorageKind
}

/** Payload of `auth:session-changed`; details follow via `auth:get-session`. */
export interface AuthSessionChangedPayload {
  status: 'authenticated' | 'anonymous'
}

/**
 * Response of `auth:open-verification-page`. The failure code covers both
 * "no login attempt is in flight" and "its user code already expired" —
 * either way there is nothing left to re-open and the pane re-offers login.
 */
export type AuthOpenVerificationPageResult =
  /** the page opened through the origin-checked external-URL gate */
  { ok: true } | { ok: false; error: 'no-login-in-flight' }

/**
 * The typed bridge the shell preload exposes as `window.aiOfficeAuth`
 * (docs/cloud-backend-auth.md §C): a thin wrapper over the channels above,
 * profile only — never tokens, never endpoint URLs. The main process
 * validates every payload; this layer adds no validation of its own.
 */
export interface AuthApi {
  /**
   * Start (or join) the device-authorization-grant login. The promise
   * settles at the terminal event (`success`/`failure`), which also
   * arrives over `onLoginEvent`; joiners get the pending waiting event
   * replayed on subscribe.
   */
  login(): Promise<void>
  /** cancel the in-flight login attempt (reports `failure/cancelled`) */
  cancelLogin(): Promise<void>
  /** revoke + wipe local credentials + open the issuer's end-session page */
  logout(): Promise<void>
  /** current session snapshot (profile only, never tokens) */
  getSession(): Promise<AuthSessionSnapshot>
  /** push: login progress over `auth:login-event`; returns the unsubscribe */
  onLoginEvent(handler: (event: AuthLoginEventPayload) => void): () => void
  /** push: session appeared/left over `auth:session-changed`; details follow via `getSession()` */
  onSessionChanged(handler: (payload: AuthSessionChangedPayload) => void): () => void
  /**
   * Re-open the in-flight login's verification page in the system browser —
   * the rescue action when the auto-open never reached it. The URL is
   * re-derived main-side and never crosses to the renderer; a typed error
   * comes back when no unexpired attempt is in flight.
   */
  openVerificationPage(): Promise<AuthOpenVerificationPageResult>
}
