/**
 * Cloud-auth IPC registration (docs/cloud-backend-auth.md §B).
 *
 * Seven channels, every payload zod-validated at this edge (the sheets IPC
 * precedent — outgoing pushes and responses are validated too, so a shape
 * bug fails loudly instead of drifting to the renderer):
 *
 * - `auth:login` — start (or join) the device flow; progress streams back
 *   over `auth:login-event` to the requesting webContents only;
 * - `auth:cancel-login` / `auth:logout` / `auth:get-session`;
 * - `auth:login-event` — push, `{status, userCode?, expiresAt?, error?}`;
 * - `auth:session-changed` — push, broadcast to every webContents;
 * - `auth:open-verification-page` — re-open the in-flight login's
 *   verification page; the URL stays main-side (typed error when no
 *   unexpired attempt is in flight).
 *
 * The renderer never receives tokens or endpoint URLs through these
 * channels; external pages open only in the main process through
 * `safeExternalUrl` with the configured issuer's origin allowlisted.
 */

import { join } from 'node:path'
import { app, ipcMain, safeStorage, shell, webContents } from 'electron'
import { z } from 'zod'
import { getShellAuthConfig } from './config'
import { AuthSessionManager } from './session-manager'
import { ElectronTokenStore } from './token-store-electron'
import {
  AUTH_CHANNELS,
  type AuthLoginEventPayload,
  type AuthSessionSnapshot,
} from '../../shared/auth-api'

export interface AuthIpcDeps {
  /** credential file path (userData/cloud-auth.json by default) */
  tokenStorePath?: string
  /**
   * Resolves when the main-process proxy bootstrap has settled; login and
   * restore traffic rides the same proxy-aware fetch stack as the rest of
   * the app (enterprise proxies keep working).
   */
  waitForProxy?: () => Promise<void>
}

// ── payload schemas (the wire contract, mirrored by shared/auth-api.ts) ──

const sessionProfileSchema = z
  .object({
    sub: z.string().min(1),
    name: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    roles: z.array(z.string()),
  })
  .strict()

const sessionSnapshotSchema = z
  .object({
    status: z.enum(['authenticated', 'anonymous']),
    profile: sessionProfileSchema.optional(),
    storage: z.enum(['encrypted', 'plain-file']),
  })
  .strict()

const loginEventSchema = z
  .object({
    status: z.enum(['waiting-for-confirmation', 'success', 'failure']),
    userCode: z.string().min(1).optional(),
    expiresAt: z.number().finite().optional(),
    error: z.string().min(1).optional(),
  })
  .strict()

const sessionChangedSchema = z
  .object({
    status: z.enum(['authenticated', 'anonymous']),
  })
  .strict()

const openVerificationPageResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: z.literal('no-login-in-flight') }).strict(),
])

/** The five request channels take no arguments; anything else is rejected. */
const noArguments = z.union([z.undefined(), z.null()])

let sessionManager: AuthSessionManager | undefined

export function registerAuthIpc(deps: AuthIpcDeps = {}): void {
  if (sessionManager !== undefined) return // registration is idempotent
  const config = getShellAuthConfig()
  const store = new ElectronTokenStore({
    path: deps.tokenStorePath ?? join(app.getPath('userData'), 'cloud-auth.json'),
    safeStorage,
  })
  const waitForProxy = deps.waitForProxy ?? ((): Promise<void> => Promise.resolve())
  const manager = new AuthSessionManager({
    config,
    store,
    storageKind: () => store.storageKind,
    openExternal: (url) => {
      // the URL already passed the safeExternalUrl + issuer-origin gate
      shell.openExternal(url).catch((error: unknown) => {
        console.warn('[auth] failed to open the issuer page in the browser:', error)
      })
    },
  })
  sessionManager = manager

  // session changes go to every webContents (home tab, editor tabs): the
  // session drives shared chrome, not just the pane that triggered it
  manager.onSessionChanged((payload) => {
    const validated = sessionChangedSchema.parse(payload)
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send(AUTH_CHANNELS.sessionChanged, validated)
    }
  })

  ipcMain.handle(AUTH_CHANNELS.login, async (event, input: unknown) => {
    noArguments.parse(input)
    await waitForProxy()
    // progress streams to the requesting webContents; the subscription ends
    // with the terminal event (success/failure) or a destroyed sender. A
    // joining caller (login already in flight) gets the pending waiting
    // event replayed synchronously on subscribe — before `unsubscribe` is
    // assigned — so it is declared up front instead of via `const`.
    const sender = event.sender
    let unsubscribe = (): void => {}
    const forward = (payload: AuthLoginEventPayload): void => {
      if (!sender.isDestroyed()) {
        sender.send(AUTH_CHANNELS.loginEvent, loginEventSchema.parse(payload))
      }
      if (payload.status !== 'waiting-for-confirmation' || sender.isDestroyed()) unsubscribe()
    }
    unsubscribe = manager.onLoginEvent(forward)
    return manager.startLogin()
  })

  ipcMain.handle(AUTH_CHANNELS.cancelLogin, (_event, input: unknown) => {
    noArguments.parse(input)
    manager.cancelLogin()
  })

  ipcMain.handle(AUTH_CHANNELS.logout, async (_event, input: unknown) => {
    noArguments.parse(input)
    await manager.logout()
  })

  ipcMain.handle(AUTH_CHANNELS.getSession, (_event, input: unknown): AuthSessionSnapshot => {
    noArguments.parse(input)
    return sessionSnapshotSchema.parse(manager.snapshot())
  })

  // the rescue action for a verification page that never reached the
  // browser: the URL is re-derived from the in-flight attempt main-side and
  // opened through the same origin-checked gate as the auto-open — it never
  // crosses to the renderer, only the typed result below does
  ipcMain.handle(AUTH_CHANNELS.openVerificationPage, (_event, input: unknown) => {
    noArguments.parse(input)
    return openVerificationPageResultSchema.parse(manager.openVerificationPage())
  })
}

/**
 * Startup restore hook — call once the proxy bootstrap has settled (the
 * refresh rides the proxy-aware fetch stack). Fire-and-forget: failures
 * leave the app logged out and are logged, never thrown into startup.
 */
export function restoreAuthSession(): void {
  void sessionManager?.restore()
}
