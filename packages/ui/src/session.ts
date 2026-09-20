/**
 * Cloud-session state for shared chrome (docs/cloud-backend-auth.md §C).
 *
 * The bridge this hook consumes is exposed by the shell preload as
 * `window.aiOfficeAuth` and typed `AuthApi` in
 * apps/shell/src/shared/auth-api.ts — the source of truth for the wire
 * shapes. packages/ cannot import from apps/, so the payload types below
 * are structural mirrors that the preload bridge is asserted to satisfy
 * (the preload types its object as `AuthApi & SessionApi`, so a drift
 * between the two fails the shell typecheck).
 *
 * Security: profile only — no type below carries a token, the device code,
 * or an endpoint URL, and the hook adds no fields of its own.
 */
import { useCallback, useEffect, useState } from 'react'

/**
 * Login progress pushed over `auth:login-event`. `userCode` is shown
 * verbatim (no reformatting) — the anti-phishing comparison step.
 */
export type SessionLoginEvent =
  | {
      /** the device code was issued; waiting for the user to approve it */
      status: 'waiting-for-confirmation'
      userCode: string
      /** epoch ms when the device code expires */
      expiresAt: number
    }
  | { status: 'success' }
  | {
      status: 'failure'
      /** stable auth error code (`network_error`, `access_denied`, …) */
      error: string
    }

/** Session profile decoded from the id token — the token itself never crosses. */
export interface SessionProfile {
  sub: string
  name?: string
  email?: string
  roles: string[]
}

/** How the refresh-token file is protected on this machine. */
export type SessionStorageKind = 'encrypted' | 'plain-file'

/** Snapshot from `getSession()`; `'plain-file'` means no keyring — UI warns. */
export interface SessionSnapshot {
  status: 'authenticated' | 'anonymous'
  profile?: SessionProfile
  storage: SessionStorageKind
}

/** Payload of the `session-changed` push; details follow via `getSession()`. */
export interface SessionChangedEvent {
  status: 'authenticated' | 'anonymous'
}

/** Structural mirror of the shell preload's `window.aiOfficeAuth` bridge. */
export interface SessionApi {
  /** start (or join) the device flow; settles at the terminal login event */
  login(): Promise<void>
  /** cancel the in-flight login attempt (reports `failure/cancelled`) */
  cancelLogin(): Promise<void>
  /** revoke + wipe local credentials + open the issuer's end-session page */
  logout(): Promise<void>
  /** current session snapshot (profile only, never tokens) */
  getSession(): Promise<SessionSnapshot>
  /** push: login progress; returns the unsubscribe */
  onLoginEvent(handler: (event: SessionLoginEvent) => void): () => void
  /** push: the session appeared or left; refetch details via `getSession()` */
  onSessionChanged(handler: (event: SessionChangedEvent) => void): () => void
}

export interface UseSessionResult {
  /**
   * Latest snapshot: `null` until the first `getSession()` resolves — and
   * stays `null` when no bridge is passed (standalone/non-shell windows).
   */
  session: SessionSnapshot | null
  /** Login progress since the last `login()` call, in arrival order. */
  loginEvents: SessionLoginEvent[]
  /** Start (or join) the device flow; resolves at the terminal event. */
  login: () => Promise<void>
  /** Cancel the in-flight login attempt. */
  cancelLogin: () => Promise<void>
  /** Log out; the `session-changed` push updates `session`. */
  logout: () => Promise<void>
  /** Re-fetch the snapshot now (runs on mount and after every push too). */
  refresh: () => Promise<void>
}

/**
 * Session state for shared chrome (account chip, Settings Account pane).
 *
 * Fetches the snapshot on mount, subscribes to both push channels with
 * strict cleanup, and derives commands that never need to be in a
 * dependency array. `api` must be a stable reference across renders
 * (`window.aiOfficeAuth` is — it is exposed once by the preload); the
 * subscription follows the reference, so an inline object would resubscribe
 * every render. Translation stays out of this module entirely — the
 * consuming component owns `t` (`useI18n()`'s `t` is not referentially
 * stable, so it must never enter a dependency array).
 *
 * Observation failures (`getSession()` rejecting) keep the last known
 * snapshot; command rejections (`login()`/`logout()` …) propagate to the
 * caller.
 */
export function useSession(api: SessionApi | undefined): UseSessionResult {
  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const [loginEvents, setLoginEvents] = useState<SessionLoginEvent[]>([])

  useEffect(() => {
    if (!api) return
    let alive = true
    const pull = (): void => {
      api
        .getSession()
        .then((snapshot) => {
          if (alive) setSession(snapshot)
        })
        .catch(() => {})
    }
    pull() // initial load
    const offLogin = api.onLoginEvent((event) => {
      if (alive) setLoginEvents((previous) => [...previous, event])
    })
    const offSession = api.onSessionChanged(() => {
      if (alive) pull() // the push is status-only; details follow via getSession
    })
    return () => {
      alive = false
      offLogin()
      offSession()
    }
  }, [api])

  const login = useCallback(async (): Promise<void> => {
    setLoginEvents([]) // a fresh attempt invalidates the previous progress
    await api?.login()
  }, [api])

  const cancelLogin = useCallback(async (): Promise<void> => {
    await api?.cancelLogin()
  }, [api])

  const logout = useCallback(async (): Promise<void> => {
    await api?.logout()
  }, [api])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await api?.getSession()
      if (snapshot) setSession(snapshot)
    } catch {
      // observation failure: keep the last known snapshot
    }
  }, [api])

  return { session, loginEvents, login, cancelLogin, logout, refresh }
}
