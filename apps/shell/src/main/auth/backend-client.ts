/**
 * Authenticated client for the cloud backend (docs/cloud-backend-auth.md §D):
 * a small fetch wrapper that attaches the session manager's Bearer token and,
 * on a 401, forces exactly one refresh through the manager's single-flight
 * machinery and retries the request once — a second 401 surfaces the
 * response, there is no retry loop.
 *
 * Transport is the plain global `fetch` like the rest of the main process:
 * `installMainProcessProxy` has already installed the proxy-aware stack, so
 * enterprise proxies keep working and no second proxy layer is added here.
 *
 * The configured base URL is validated once through the SSRF gate at
 * construction (operator config, so private/loopback hosts are allowed —
 * dev runs against localhost and enterprises deploy on internal networks);
 * a gate failure fails construction with a typed config error.
 *
 * Electron-free by injection (transport and gate are seams), so the wrapper
 * is unit-testable without a main process.
 */

import type { FetchLike } from '@genoffice/auth'
import { isSafeRemoteUrl, type SafeRemoteUrlOptions } from '@genoffice/electron-utils'
import type { AuthBackendProbeResult } from '../../shared/auth-api'

/** The session-manager surface the client consumes (the token seam). */
export interface BackendSession {
  /**
   * A currently-valid access token; `force` demands a fresh one through the
   * manager's shared single-flight refresh (see AuthSessionManager).
   */
  getAccessToken(options?: { force?: boolean }): Promise<string>
}

/** Stable error code — never a message (messages can embed endpoint URLs). */
export type BackendClientErrorCode = 'config'

/** Typed construction/config failure; transport and auth errors propagate as-is. */
export class BackendClientError extends Error {
  readonly code: BackendClientErrorCode

  constructor(message: string, options: { code: BackendClientErrorCode }) {
    super(message)
    this.name = this.constructor.name
    this.code = options.code
  }
}

export interface BackendClientOptions {
  /** backend base URL from the auth config (SSRF-gated at construction) */
  baseUrl: string
  session: BackendSession
  /**
   * Transport seam (default: the plain global fetch — the main-process stack
   * is already proxy-installed; do not add another proxy layer).
   */
  fetchFn?: FetchLike
  /** SSRF-gate seam for tests (default `isSafeRemoteUrl`) */
  isSafeUrl?: (url: unknown, options?: SafeRemoteUrlOptions) => Promise<boolean>
}

export class BackendClient {
  private readonly base: URL
  private readonly session: BackendSession
  private readonly fetchFn: FetchLike

  private constructor(base: URL, options: BackendClientOptions) {
    this.base = base
    this.session = options.session
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init))
  }

  /**
   * Build the client, validating the base URL once: parseable, http(s), no
   * embedded credentials, and through the SSRF gate (private hosts allowed —
   * trusted operator config). Any failure rejects with a typed config error
   * and no client is built.
   */
  static async create(options: BackendClientOptions): Promise<BackendClient> {
    let url: URL
    try {
      url = new URL(options.baseUrl)
    } catch {
      throw new BackendClientError('The configured backend URL is not an absolute URL', {
        code: 'config',
      })
    }
    if (url.username || url.password) {
      throw new BackendClientError('The configured backend URL must not carry credentials', {
        code: 'config',
      })
    }
    const gate = options.isSafeUrl ?? isSafeRemoteUrl
    // operator config: loopback/private targets are legitimate (dev default
    // is localhost:8000), so the gate runs with allowPrivateHosts
    if (!(await gate(options.baseUrl, { allowPrivateHosts: true }))) {
      throw new BackendClientError('The configured backend URL failed the SSRF gate', {
        code: 'config',
      })
    }
    return new BackendClient(url, options)
  }

  /** Absolute request URL: the base path prefix is kept, trailing slashes collapse. */
  private url(path: string): string {
    const base = `${this.base.origin}${this.base.pathname.replace(/\/+$/, '')}`
    return `${base}/${path.replace(/^\/+/, '')}`
  }

  /**
   * One authenticated request: attach the session's Bearer token, and on a
   * 401 force exactly one refresh (same single-flight as the proactive
   * timer) and retry once. Any other status — including a second 401 —
   * surfaces as the returned response; callers decide what it means.
   * Token errors (typed `not_logged_in` and friends) and transport failures
   * propagate unchanged.
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async (token: string): Promise<Response> => {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${token}`)
      return this.fetchFn(this.url(path), { ...init, headers })
    }
    const response = await send(await this.session.getAccessToken())
    if (response.status !== 401) return response
    // refresh once (through the manager's shared single-flight) and retry
    // once — whatever comes back now is final, there is no loop
    return send(await this.session.getAccessToken({ force: true }))
  }

  /**
   * The account pane's connectivity probe: `GET /whoami` with the session
   * token. The result is the wire payload — `{ok, status?}` only, never a
   * URL, token, or body. Network failures, a logged-out session, and a
   * config-gated client all read as not connected (details stay in the main
   * process).
   */
  async probe(): Promise<AuthBackendProbeResult> {
    try {
      const response = await this.fetch('/whoami')
      return response.ok
        ? { ok: true, status: response.status }
        : { ok: false, status: response.status }
    } catch (error) {
      console.warn('[backend] whoami probe failed:', error)
      return { ok: false }
    }
  }
}
