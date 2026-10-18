/**
 * Cloud-documents IPC registration (docs/cloud-backend-auth.md, Phase 7d —
 * the home cloud section's typed surface).
 *
 * Four channels, every payload zod-validated at this edge (the auth IPC
 * precedent in `auth/ipc.ts`: outgoing pushes and responses are validated
 * too, so a shape bug fails loudly instead of drifting to the renderer):
 *
 * - `cloud:list-documents` — the registry's cached snapshot; when signed in
 *   it also kicks the registry's rate-limited background refresh, whose
 *   result arrives over `cloud:documents-changed` (only on a real change);
 * - `cloud:toggle-starred` — `{cloudId, starred}`; offline-safe (queued in
 *   the registry, replayed on the next refresh);
 * - `cloud:mark-opened` — `{cloudId}`; the server-side recents stamp;
 * - `cloud:set-print-policy` — `{cloudId, policy}`; the Ruling 13 per-file
 *   print policy (optimistic cache edit, reverted when the write fails);
 * - `cloud:documents-changed` — push, broadcast to every webContents with
 *   `{reason}` only.
 *
 * The renderer never receives tokens or endpoint URLs through these
 * channels, and a cloudId is only ever a non-empty bounded string — the
 * registry URL-encodes it before it touches a path, never interpolates it.
 */

import { join } from 'node:path'
import { app, ipcMain, webContents } from 'electron'
import { z } from 'zod'
import { CloudDocumentsRegistry } from './cloud-docs'
import { getAuthSessionManager, getBackendClient } from './ipc'
import { CLOUD_DOCS_CHANNELS } from '../../shared/cloud-docs-api'
import type { CloudDocumentsChangedPayload } from '../../shared/cloud-docs-api'

// ── payload schemas (the wire contract, mirrored by shared/cloud-docs-api.ts) ──

const cloudIdSchema = z.string().min(1).max(128)

const toggleStarredArgs = z
  .object({
    cloudId: cloudIdSchema,
    starred: z.boolean(),
  })
  .strict()

const markOpenedArgs = z
  .object({
    cloudId: cloudIdSchema,
  })
  .strict()

const setPrintPolicyArgs = z
  .object({
    cloudId: cloudIdSchema,
    policy: z.enum(['allow', 'deny']),
  })
  .strict()

const listDocumentsArgs = z.union([z.undefined(), z.null()])

const snapshotSchema = z
  .object({
    available: z.boolean(),
    documents: z.array(
      z
        .object({
          cloudId: z.string().min(1),
          name: z.string(),
          kind: z.string(),
          sizeBytes: z.number().nonnegative(),
          currentVersion: z.number().int().positive(),
          createdAt: z.string(),
          updatedAt: z.string(),
          starred: z.boolean(),
          lastOpenedAt: z.string().nullable(),
          printPolicy: z.enum(['allow', 'deny']),
        })
        .strict(),
    ),
    syncedAt: z.number().nonnegative(),
    stale: z.boolean(),
    pendingStars: z.number().int().nonnegative(),
  })
  .strict()

const documentsChangedSchema = z
  .object({
    reason: z.enum(['refreshed', 'starred', 'opened']),
  })
  .strict()

/** The verified `sub` of the live session, or null when signed out. */
function currentSub(): string | null {
  const snapshot = getAuthSessionManager()?.snapshot()
  if (snapshot === undefined || snapshot.status !== 'authenticated') return null
  return snapshot.profile?.sub ?? null
}

export interface CloudDocsIpcDeps {
  /** registry cache file path (userData/cloud-documents.json by default) */
  storePath?: string
  /**
   * Resolves when the main-process proxy bootstrap has settled; the first
   * refresh rides the same proxy-aware fetch stack as the auth traffic.
   */
  waitForProxy?: () => Promise<void>
}

/** The module-scoped registry (one per process, built on registration). */
let registry: CloudDocumentsRegistry | undefined

/**
 * The live cloud-documents registry — undefined until `registerCloudDocsIpc`
 * ran (and forever in a process that never registers it). Main-process
 * consumers (the storageMode routing, Task 16) use it for `document(cloudId)`
 * lookups and the `onDocumentRekeyed` hook.
 */
export function getCloudDocumentsRegistry(): CloudDocumentsRegistry | undefined {
  return registry
}

/**
 * Builds and owns the registry, registers the channels. Idempotent; call
 * once from the shell's registration list, after `registerAuthIpc` (the
 * registry reads the session manager and the shared backend client).
 */
export function registerCloudDocsIpc(deps: CloudDocsIpcDeps = {}): void {
  if (registry !== undefined) return
  const waitForProxy = deps.waitForProxy ?? ((): Promise<void> => Promise.resolve())
  registry = new CloudDocumentsRegistry({
    // the shared client: SSRF-gated construction, Bearer + refresh-on-401
    client: getBackendClient,
    // the session gate: no sub → no server calls and no cache served
    session: { currentSub },
    storePath: deps.storePath ?? join(app.getPath('userData'), 'cloud-documents.json'),
  })

  // registry changes are broadcast to every webContents (the home cloud
  // section lives in the shell window, but any editor tab could list too)
  registry.onChange((reason) => {
    const payload: CloudDocumentsChangedPayload = documentsChangedSchema.parse({ reason })
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send(CLOUD_DOCS_CHANNELS.documentsChanged, payload)
    }
  })

  // A session change re-evaluates the registry's account binding immediately:
  // sign-out must clear the cloud section even while the panel sits idle and
  // nothing else would read the registry; an account switch re-lists for the
  // new owner. The registry emits only when the visible content changed.
  getAuthSessionManager()?.onSessionChanged(() => registry?.sessionChanged())

  ipcMain.handle(CLOUD_DOCS_CHANNELS.listDocuments, async (_event, input: unknown) => {
    listDocumentsArgs.parse(input)
    const live = registry
    if (live === undefined) throw new Error('cloud-documents registry is not registered')
    const snapshot = live.snapshot()
    // serve the cache instantly; when signed in, kick the rate-limited
    // background refresh — its result arrives pushed over
    // cloud:documents-changed, and autoRefresh's interval is what keeps the
    // list → push → list cycle a section produces from becoming a fetch loop
    if (currentSub() !== null) void waitForProxy().then(() => live.autoRefresh())
    return snapshotSchema.parse(snapshot)
  })

  ipcMain.handle(CLOUD_DOCS_CHANNELS.toggleStarred, async (_event, input: unknown) => {
    const live = registry
    if (live === undefined) throw new Error('cloud-documents registry is not registered')
    const { cloudId, starred } = toggleStarredArgs.parse(input)
    return snapshotSchema.parse(await live.toggleStarred(cloudId, starred))
  })

  ipcMain.handle(CLOUD_DOCS_CHANNELS.markOpened, async (_event, input: unknown) => {
    const live = registry
    if (live === undefined) throw new Error('cloud-documents registry is not registered')
    const { cloudId } = markOpenedArgs.parse(input)
    await live.markOpened(cloudId)
  })

  ipcMain.handle(CLOUD_DOCS_CHANNELS.setPrintPolicy, async (_event, input: unknown) => {
    const live = registry
    if (live === undefined) throw new Error('cloud-documents registry is not registered')
    const { cloudId, policy } = setPrintPolicyArgs.parse(input)
    return snapshotSchema.parse(await live.setPrintPolicy(cloudId, policy))
  })
}
