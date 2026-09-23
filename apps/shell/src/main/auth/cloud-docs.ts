/**
 * Cloud-documents registry (docs/cloud-backend-auth.md, Phase 7d
 * "Identity"): the main-process cache of the signed-in account's
 * server-side document list, keyed by cloud document id.
 *
 * The registry exists because every identity surface that was keyed by an
 * absolute path needs a cloud twin that is keyed by the server-assigned id
 * instead — recents/starred (server-side `document_meta` now) and the home
 * tree's cloud section. It provides:
 *
 * - `snapshot()`: the cached list + freshness state (`stale` = the last
 *   refresh failed, what you see is the last-known list) — served instantly,
 *   never blocking on the network;
 * - `refresh()`: re-fetch `GET /documents` through the shared backend client
 *   (SSRF-gated construction, Bearer + refresh-once-on-401); only runs
 *   signed-in. A failed refresh keeps the cache and raises the stale flag
 *   rather than wiping the offline view;
 * - `toggleStarred()`: optimistically applies the flag to the cache and
 *   sends `PUT /documents/:id/starred`. When the send fails (offline / dead
 *   session) the toggle stays in a local queue and is replayed on the next
 *   successful refresh. **Documented policy: server last-write-wins** on
 *   `starred`/`lastOpenedAt` — these fields are deliberately If-Match-free
 *   on the server, so an offline star never conflicts with a concurrent
 *   edit; the last delivered write simply wins;
 * - `markOpened()`: `POST /documents/:id/opened`, the server-side recents
 *   stamp. Fire-and-forget: a failure is logged, never surfaced — an
 *   unrecorded open only means a slightly older recents stamp.
 *
 * The cache and the star queue persist to `userData/cloud-documents.json`,
 * tagged with a salted hash of the account's `sub` (never the sub itself) —
 * a different account's cache is unreadable and dropped, exactly like the
 * Genspark cloud-projects store (`main/cloud-projects.ts`).
 *
 * ## `onDocumentRekeyed` (the Task 14 carry-over)
 *
 * `RemoteDocumentStore` silently re-points a document's cloudId on the
 * server's 404 self-heal (the mirror vanished → recreated under a fresh id)
 * and on `?conflict=copy` (new id for the copy). Anything keyed by the old
 * id — this registry, open tabs, stars — must follow. The contract the
 * Phase 7 rollout task (storageMode routing) wires up:
 *
 * - the adapter wiring subscribes through
 *   {@link CloudDocumentsRegistry.onDocumentRekeyed} and re-keys its own
 *   state (open tab identities most importantly) on every event;
 * - it also calls {@link CloudDocumentsRegistry.rekeyDocument} for each
 *   re-point, so the registry's cache entry and queued stars follow, and the
 *   registry fans the event out to every other subscriber;
 * - until that wiring exists the registry re-keys its OWN entries on the
 *   next refresh anyway (the list is keyed by id server-side, so a stale id
 *   ages out), but open tabs would keep the dead id — the hook is what makes
 *   them follow immediately.
 *
 * See docs/cloud-storage.md ("TODO before rollout") for the tie-in note.
 */

import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type {
  CloudDocsChangeReason,
  CloudDocumentEntry,
  CloudDocumentsSnapshot,
} from '../../shared/cloud-docs-api'
import type { BackendClient } from './backend-client'

/** Star toggles waiting to be delivered (replayed FIFO on the next refresh). */
export interface PendingStar {
  cloudId: string
  starred: boolean
}

/** disk shape: the cached list + star queue plus the owner tag */
interface StoredRegistry {
  owner?: string
  documents?: CloudDocumentEntry[]
  syncedAt?: number
  pendingStars?: PendingStar[]
}

/** The registry's view of the session (the seam the shell index injects). */
export interface CloudDocsSession {
  /** authenticated sub, or null when signed out — gates every server call */
  currentSub(): string | null
}

export interface CloudDocumentsRegistryOptions {
  /** backend HTTP surface; undefined means "no client yet" (nothing runs) */
  client: () => Promise<BackendClient> | undefined
  session: CloudDocsSession
  /** cache file path (userData/cloud-documents.json in the app) */
  storePath: string
  /** clock seam for tests */
  now?: () => number
}

/**
 * Account tag the cache is bound to: a salted hash of the verified `sub`
 * (never the sub itself). Switching or logging out makes the stored list
 * unreadable, so one account can never see another's documents.
 */
export function cloudDocsOwner(sub: string): string {
  return createHash('sha256').update(`genoffice-cloud-docs:${sub}`).digest('hex').slice(0, 16)
}

export class CloudDocumentsRegistry {
  private readonly client: () => Promise<BackendClient> | undefined
  private readonly session: CloudDocsSession
  private readonly storePath: string
  private readonly now: () => number

  /** the live cache; null until a list was loaded for the current account */
  private documents: CloudDocumentEntry[] | null = null
  private syncedAt = 0
  /** true when the last refresh attempt failed and the cache is last-known */
  private stale = false
  private pendingStars: PendingStar[] = []
  /** the owner the loaded cache belongs to ('' = nothing loaded) */
  private loadedFor = ''
  private refreshInFlight: Promise<CloudDocumentsSnapshot> | null = null
  private readonly changeListeners = new Set<(reason: CloudDocsChangeReason) => void>()
  private readonly rekeyListeners = new Set<(oldCloudId: string, newCloudId: string) => void>()

  constructor(options: CloudDocumentsRegistryOptions) {
    this.client = options.client
    this.session = options.session
    this.storePath = options.storePath
    this.now = options.now ?? ((): number => Date.now())
    this.loadFromDisk()
  }

  // ── Session/owner handling ──────────────────────────────────────────

  /** The signed-in account's tag, or '' when signed out. */
  private owner(): string {
    const sub = this.session.currentSub()
    return sub === null ? '' : cloudDocsOwner(sub)
  }

  /** Loads the persisted cache when it belongs to the current account. */
  private loadFromDisk(): void {
    const owner = this.owner()
    if (owner === '') {
      this.reset('')
      return
    }
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf-8')) as StoredRegistry
      if (raw.owner !== owner) {
        // another account's cache (or a stale one from before logout):
        // drop it rather than leave it around
        this.clearStore()
        this.reset(owner)
        return
      }
      this.documents = Array.isArray(raw.documents) ? raw.documents : null
      this.syncedAt = Number(raw.syncedAt) || 0
      this.pendingStars = Array.isArray(raw.pendingStars) ? raw.pendingStars : []
      this.stale = false // never synced reads as unavailable, not stale
      this.loadedFor = owner
    } catch {
      this.reset(owner)
    }
  }

  private reset(owner: string): void {
    this.documents = null
    this.syncedAt = 0
    this.stale = false
    this.pendingStars = []
    this.loadedFor = owner
  }

  private clearStore(): void {
    try {
      unlinkSync(this.storePath)
    } catch {
      // nothing cached; fine
    }
  }

  private persist(): void {
    if (this.documents === null) return // nothing worth persisting
    const stored: StoredRegistry = {
      owner: this.loadedFor,
      documents: this.documents,
      syncedAt: this.syncedAt,
      pendingStars: this.pendingStars,
    }
    try {
      writeFileSync(this.storePath, JSON.stringify(stored))
    } catch {
      // the cache is best-effort; the in-memory list still serves
    }
  }

  // ── Snapshot ────────────────────────────────────────────────────────

  /**
   * Re-loads the persisted cache when the signed-in account changed since
   * the cache was loaded (login, logout, switch). Every read and write goes
   * through this first, so one account is never served another's list.
   */
  private ensureOwnerLoaded(): void {
    const owner = this.owner()
    if (this.loadedFor !== owner) this.loadFromDisk()
  }

  /**
   * The cached list with its queued stars re-applied (a pending local edit
   * wins over the server state until it is delivered) — the offline view.
   */
  snapshot(): CloudDocumentsSnapshot {
    this.ensureOwnerLoaded()
    if (this.documents === null) {
      return { available: false, documents: [], syncedAt: 0, stale: false, pendingStars: 0 }
    }
    const byId = new Map(this.documents.map((d) => [d.cloudId, { ...d }]))
    for (const pending of this.pendingStars) {
      const entry = byId.get(pending.cloudId)
      if (entry !== undefined) entry.starred = pending.starred
    }
    return {
      available: true,
      documents: [...byId.values()],
      syncedAt: this.syncedAt,
      stale: this.stale,
      pendingStars: this.pendingStars.length,
    }
  }

  /** One cached entry by cloudId (undefined when unknown/not loaded). */
  document(cloudId: string): CloudDocumentEntry | undefined {
    this.ensureOwnerLoaded()
    return this.documents?.find((d) => d.cloudId === cloudId)
  }

  // ── Refresh ─────────────────────────────────────────────────────────

  /**
   * Re-sync the list from the server. Replays the star queue first (so the
   * fetched list reflects the delivered toggles), then fetches. Single-flight:
   * concurrent callers share one run. A failure keeps the cache, raises the
   * stale flag, and preserves the queue — the next refresh retries.
   */
  refresh(): Promise<CloudDocumentsSnapshot> {
    this.ensureOwnerLoaded()
    if (this.owner() === '') {
      // signed out: nothing to fetch and nothing to serve
      return Promise.resolve(this.snapshot())
    }
    if (this.refreshInFlight !== null) return this.refreshInFlight
    const owner = this.owner()
    const run = this.doRefresh(owner).finally(() => {
      if (this.refreshInFlight === run) this.refreshInFlight = null
    })
    this.refreshInFlight = run
    return run
  }

  private async doRefresh(owner: string): Promise<CloudDocumentsSnapshot> {
    let client: BackendClient | undefined
    try {
      client = await this.client()
    } catch {
      client = undefined // config-gated construction: treat as offline
    }
    if (client === undefined) {
      this.stale = this.documents !== null
      return this.snapshot()
    }
    try {
      await this.replayStars(client)
      const response = await client.fetch('/documents')
      if (!response.ok) throw new Error(`document list answered HTTP ${response.status}`)
      const body = (await response.json()) as { documents?: unknown }
      if (!Array.isArray(body.documents)) throw new Error('document list response malformed')
      this.documents = body.documents.map(parseEntry)
      this.syncedAt = this.now()
      this.stale = false
      this.persist()
      this.emitChange('refreshed')
    } catch (error) {
      // offline / server down / dead session: keep the last-known list and
      // raise the stale flag; queued stars survive for the next refresh
      console.warn('[cloud-docs] refresh failed:', error)
      this.stale = true
    }
    if (this.session.currentSub() === null || this.owner() !== owner) {
      // the account left while the request was in flight: what came back is
      // the old account's data and must not be served
      this.loadFromDisk()
    }
    return this.snapshot()
  }

  /** Delivers every queued star toggle, dropping the ones the server took. */
  private async replayStars(client: BackendClient): Promise<void> {
    while (this.pendingStars.length > 0) {
      const [pending] = this.pendingStars
      const response = await client.fetch(
        `/documents/${encodeURIComponent(pending.cloudId)}/starred`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ starred: pending.starred }),
        },
      )
      if (!response.ok) {
        // a definitive 404 means the document is gone — drop the toggle so
        // it cannot wedge the queue; anything else (offline, 5xx) keeps it
        if (response.status === 404) {
          this.pendingStars.shift()
          continue
        }
        throw new Error(`star replay answered HTTP ${response.status}`)
      }
      this.pendingStars.shift()
    }
    this.persist()
  }

  // ── Mutations ───────────────────────────────────────────────────────

  /**
   * Star / unstar one document. The cache is updated optimistically; the
   * server write is attempted at once and, when it fails, queued for replay
   * on the next successful refresh (last-write-wins server-side).
   */
  async toggleStarred(cloudId: string, starred: boolean): Promise<CloudDocumentsSnapshot> {
    this.ensureOwnerLoaded()
    if (this.documents === null) {
      // nothing cached: there is no offline view to optimistically edit,
      // and the toggle cannot be replayed against an unknown list — drop it
      return this.snapshot()
    }
    const entry = this.documents.find((d) => d.cloudId === cloudId)
    if (entry === undefined) return this.snapshot()
    entry.starred = starred
    this.queueStar({ cloudId, starred })
    this.emitChange('starred')
    let client: BackendClient | undefined
    try {
      client = await this.client()
    } catch {
      client = undefined
    }
    if (client !== undefined) {
      try {
        const response = await client.fetch(`/documents/${encodeURIComponent(cloudId)}/starred`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ starred }),
        })
        if (response.ok || response.status === 404) {
          this.dequeueStar(cloudId)
          this.persist()
          return this.snapshot()
        }
        console.warn(`[cloud-docs] star toggle answered HTTP ${response.status}; queued`)
      } catch (error) {
        console.warn('[cloud-docs] star toggle failed; queued for replay:', error)
      }
    }
    this.persist()
    return this.snapshot()
  }

  /** The server-side recents stamp for an open. Fire-and-forget. */
  async markOpened(cloudId: string): Promise<void> {
    const entry = this.document(cloudId)
    let client: BackendClient | undefined
    try {
      client = await this.client()
    } catch {
      client = undefined
    }
    if (client === undefined) return
    try {
      const response = await client.fetch(`/documents/${encodeURIComponent(cloudId)}/opened`, {
        method: 'POST',
      })
      if (!response.ok) {
        console.warn(`[cloud-docs] open stamp answered HTTP ${response.status}`)
        return
      }
      const body = (await response.json()) as { lastOpenedAt?: unknown }
      // keep the cache in step with what the server now records, so the
      // recents order does not wait for the next full refresh
      if (entry !== undefined && typeof body.lastOpenedAt === 'string') {
        entry.lastOpenedAt = body.lastOpenedAt
        this.persist()
        this.emitChange('opened')
      }
    } catch (error) {
      console.warn('[cloud-docs] open stamp failed:', error)
    }
  }

  // ── Queue helpers ───────────────────────────────────────────────────

  /** Appends the toggle, replacing any earlier one for the same document. */
  private queueStar(pending: PendingStar): void {
    this.pendingStars = this.pendingStars.filter((p) => p.cloudId !== pending.cloudId)
    this.pendingStars.push(pending)
  }

  /** Removes the delivered toggle for a document (no-op when absent). */
  private dequeueStar(cloudId: string): void {
    this.pendingStars = this.pendingStars.filter((p) => p.cloudId !== cloudId)
  }

  // ── Listeners ───────────────────────────────────────────────────────

  /** Fired after a refresh, a star, or an open stamp; the renderer re-lists. */
  onChange(handler: (reason: CloudDocsChangeReason) => void): () => void {
    this.changeListeners.add(handler)
    return () => this.changeListeners.delete(handler)
  }

  private emitChange(reason: CloudDocsChangeReason): void {
    for (const handler of [...this.changeListeners]) handler(reason)
  }

  /**
   * The Task 14 carry-over hook: subscribe to cloudId re-points. The remote
   * adapter's 404 self-heal (mirror vanished → recreated under a fresh id)
   * and its `?conflict=copy` path both change a document's id; the
   * storageMode wiring (Phase 7 rollout, Task 16) subscribes here to re-key
   * its own state — most importantly open tab identities — and calls
   * {@link rekeyDocument} for each re-point so the registry's cache and star
   * queue follow too. Listeners also fire for rekeys this registry applies
   * itself, so every consumer stays in step from one event source.
   */
  onDocumentRekeyed(handler: (oldCloudId: string, newCloudId: string) => void): () => void {
    this.rekeyListeners.add(handler)
    return () => this.rekeyListeners.delete(handler)
  }

  /**
   * Re-points a cached document from one cloudId to another (the adapter
   * re-keyed it server-side): the cache entry, its queued stars, and the
   * registered listeners (the tab manager's identity, Task 16) follow.
   */
  rekeyDocument(oldCloudId: string, newCloudId: string): void {
    if (this.documents === null || oldCloudId === newCloudId) return
    const entry = this.documents.find((d) => d.cloudId === oldCloudId)
    if (entry === undefined) return
    entry.cloudId = newCloudId
    for (const pending of this.pendingStars) {
      if (pending.cloudId === oldCloudId) pending.cloudId = newCloudId
    }
    this.persist()
    this.emitChange('refreshed')
    for (const handler of [...this.rekeyListeners]) handler(oldCloudId, newCloudId)
  }

  /** Test/teardown hook: drop all listeners. */
  dispose(): void {
    this.changeListeners.clear()
    this.rekeyListeners.clear()
  }
}

/** Validates one server list item into a registry entry (defensive parse). */
function parseEntry(raw: unknown): CloudDocumentEntry {
  if (raw === null || typeof raw !== 'object') throw new Error('document entry is not an object')
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '') throw new Error('document entry carries no id')
  return {
    cloudId: r.id,
    name: typeof r.name === 'string' ? r.name : '',
    kind: typeof r.kind === 'string' ? r.kind : '',
    sizeBytes: typeof r.size === 'number' ? r.size : 0,
    currentVersion: typeof r.currentVersion === 'number' ? r.currentVersion : 1,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    starred: r.starred === true,
    lastOpenedAt: typeof r.lastOpenedAt === 'string' ? r.lastOpenedAt : null,
  }
}
