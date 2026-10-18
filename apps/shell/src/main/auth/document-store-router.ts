/**
 * `documentStoreRouter` (docs/cloud-backend-auth.md, "Document storage
 * modes" — save/open routing, Phase 7e): the `DocumentStore` the docs editor
 * is handed through the T14 `setDocumentStore` seam, which picks the adapter
 * by `(storageMode, session state)`:
 *
 * | Mode              | Session | Adapter  | Notes                                        |
 * | ----------------- | ------- | -------- | -------------------------------------------- |
 * | `local`           | either  | local    | today's behavior, unchanged                  |
 * | `remote`          | live    | remote   | server is the only persistent copy           |
 * | `hybrid`          | live    | hybrid   | local working copy + upload-on-save mirror   |
 * | `remote`/`hybrid` | none    | local    | logout fallback for existing local docs      |
 *
 * The router is installed ONCE and re-resolves per operation — the mode and
 * session seams are live closures, so a mode change or a sign-out takes
 * effect on the very next op without re-installing anything.
 *
 * ## A document keeps the adapter it was opened under
 *
 * The ruling: the docs editor gets its store at startup AND on mode/session
 * changes — re-resolve; **open tabs keep their current store until closed**.
 * A module-global swap cannot honor that sentence (every open tab shares the
 * installed store), so the router pins the adapter per document instead: the
 * first cloud op (a save that mints the server copy, an open-from-cloud
 * download) pins {@link RoutedDoc.store}, and later ops on the same path keep
 * going to the pinned adapter until the entry is dropped (tab close for a
 * remote scratch document). A mode switch therefore changes routing for NEW
 * opens and for the opt-in migration, never mid-flight for an open document.
 * Documented in docs/cloud-storage.md.
 *
 * ## Ref identity (the adapters' mutable-handle contract)
 *
 * The docs handlers hand every op a fresh `{path}` literal; the remote and
 * hybrid adapters instead require ONE ref object per document (they record
 * `cloudId`/`version`/`conflicted` back onto it — a fresh literal per call
 * would create a new server document on every save). The router interns one
 * ref per path and resolves every op through it, so the adapters' bookkeeping
 * sticks. The pin is also what lets the router see a cloud id re-point (the
 * remote adapter's 404 self-heal and `?conflict=copy` both change it): the
 * diff before/after a cloud op fans out to the registry (`rekeyDocument`) and
 * the open tabs (`rekeyTabs`) — the Task 14 carry-over.
 *
 * ## The persistent path → cloudId association
 *
 * A ref is in-memory, so without help the first save after an app restart
 * would mint a SECOND server document for a file that already has one (every
 * hybrid doc would fork its version history once per session). The router
 * therefore keeps `userData/cloud-document-index.json`, the document twin of
 * the remote project adapter's index: the moment a path gains a cloud id the
 * pair is recorded, and an interned ref is seeded from it on the next launch.
 * Only the id is stored, never the version — a stale `If-Match` would turn a
 * benign cross-session save into a conflict copy, while no version at all
 * makes it a plain last-writer-wins upload. In `local` mode the association
 * is ignored (the mode never talks to the server) but kept, so switching back
 * to hybrid resumes the same server document.
 *
 * ## Opening a plain local file while a cloud mode is active
 *
 * File > Open, the recents rows, and the folder tree are path-keyed, and a
 * user switching to remote/hybrid still has files on disk. An uninterned path
 * with a real file and no recorded association therefore reads through the
 * local adapter (today's behavior); its first save then uploads/mirrors per
 * the active mode. Paths WITH an association follow the mode instead — in
 * `remote` the server is authoritative even when a stale local file exists.
 *
 * ## Per-mode autosave
 *
 * `writeRecovery` on a remote-routed document is the server autosave: the
 * bytes are PUT as a new version (the crash-recovery copy IS the server
 * copy), and the ephemeral scratch buffer is not written at all — a reopen
 * downloads the newest version, so there is nothing left to offer as
 * "recovered". Local and hybrid documents keep today's recovery-buffer
 * semantics (hybrid's mirror rides the next save).
 *
 * ## Scratch lifecycle (remote mode)
 *
 * The remote adapter's scratch space holds the downloaded document (engines
 * and lazy-media want a real file) and nothing else here. A scratch document
 * is deleted when its last owner goes away (`forgetOwner` — tab closed), the
 * whole space is wiped on clean exit (`registerExitWipe`, plus
 * {@link DocumentStoreRouter.wipeScratch} from the shell's `will-quit`), and
 * files a crashed run left behind are swept at startup
 * ({@link DocumentStoreRouter.sweepStaleScratch}) — nothing in the space is
 * ever a persistent copy.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import type { CloudDocumentsRegistry } from './cloud-docs'
import {
  HybridDocumentStore,
  LocalDocumentStore,
  RemoteDocumentStore,
  type DocumentConflictEvent,
  type DocumentTransport,
  type PendingDocumentUpload,
} from '@genoffice/document-store'
import type {
  DocumentRef,
  DocumentStat,
  DocumentStore,
  RecoveryStamp,
} from '@genoffice/document-store'
import type { StorageMode } from '../../shared/storage-mode-api'

/** One document this router has routed: the interned ref + its pinned adapter. */
interface RoutedDoc {
  /** the mutable handle every op on this path shares (see the header) */
  ref: DocumentRef
  /** the adapter chosen at first cloud contact; undefined until then */
  store?: DocumentStore
  /** owners that may write it (a remote scratch file dies with its last owner) */
  owners: Set<number>
  /** remote mode: `ref.path` is an ephemeral scratch file this router wipes */
  scratch: boolean
}

/** Disk shape of the association index (`version` guards the layout). */
interface StoredIndex {
  version: 1
  documents: Record<string, { cloudId: string }>
}

/** The tab-opening plan `cloud:open-document` acts on (routed per mode). */
export type OpenCloudDocumentPlan =
  | {
      /** remote mode: open an editor tab keyed by cloudId loading from scratch */
      kind: 'remote'
      cloudId: string
      /** the scratch path the tab loads (and saves back) through */
      path: string
      name: string
      /** the registry kind that picked the editor tab */
      documentKind: string
    }
  | {
      /** local/hybrid mode: the download landed, the tab is keyed by path */
      kind: 'local'
      path: string
      name: string
      /** the registry kind that picked the editor tab */
      documentKind: string
    }

export type OpenCloudDocumentOutcome =
  | { ok: true; plan: OpenCloudDocumentPlan }
  | { ok: false; error: 'sign-in-required' | 'unsupported-kind' | 'not-found' | 'unavailable' }

export interface DocumentStoreRouterDeps {
  /** the persisted storageMode (read per resolution — the setting can change) */
  mode: () => StorageMode
  /** an authenticated session is live (the remote/hybrid requirement) */
  sessionActive: () => boolean
  /** authenticated transport (the shared backend client's fetch, per call) */
  transport: DocumentTransport
  /** `LocalDocumentStore` root (userData: recovery copies + originals archive) */
  localRootDir: string
  /** the remote adapter's scratch dir (wiped on exit, swept at startup) */
  scratchDir: string
  /** where the path → cloudId association index persists */
  indexPath: string
  /** the GenOffice documents folder (hybrid/local cloud-open downloads land here) */
  documentsDir: () => string
  /** the cloud-documents registry (name lookup + re-key fan-out); optional in tests */
  registry?: () => CloudDocumentsRegistry | undefined
  /** open tabs follow a cloud id re-point (the tab manager's rekeyTabCloudId) */
  rekeyTabs?: (oldCloudId: string, newCloudId: string, name?: string) => void
  /** a path just minted its server identity (the shell binds the tab's cloudId) */
  onCloudIdMinted?: (path: string, cloudId: string) => void
  /** a hybrid mirror attempt did not land (surfaced, never thrown) */
  onPendingUpload?: (pending: PendingDocumentUpload) => void
  /** a remote save landed as a conflict copy (surfaced, never thrown) */
  onConflict?: (conflict: DocumentConflictEvent) => void
  /** exit-hook registration for the scratch wipe (process.on('exit') in the app) */
  onExit?: (wipe: () => void) => void
}

export class DocumentStoreRouter implements DocumentStore {
  readonly localStore: LocalDocumentStore
  readonly remoteStore: RemoteDocumentStore
  readonly hybridStore: HybridDocumentStore

  private readonly mode: () => StorageMode
  private readonly sessionActive: () => boolean
  private readonly documentsDir: () => string
  private readonly scratchDir: string
  private readonly indexPath: string
  private readonly registry: () => CloudDocumentsRegistry | undefined
  private readonly rekeyTabs: ((oldCloudId: string, newCloudId: string) => void) | undefined
  private readonly onCloudIdMinted: ((path: string, cloudId: string) => void) | undefined
  /** interned documents: path → the ref + pinned adapter (the header's contract) */
  private readonly docs = new Map<string, RoutedDoc>()
  /** persisted path → cloudId associations (survive restarts; see the header) */
  private readonly associations = new Map<string, string>()
  /** cloudId → the local file a hybrid/local open downloaded this session */
  private readonly downloadTargets = new Map<string, string>()
  /** one write queue per document: path → the queue tail (never rejects) */
  private readonly writeQueues = new Map<string, Promise<unknown>>()

  constructor(deps: DocumentStoreRouterDeps) {
    this.mode = deps.mode
    this.sessionActive = deps.sessionActive
    this.documentsDir = deps.documentsDir
    this.scratchDir = deps.scratchDir
    this.indexPath = deps.indexPath
    this.registry = deps.registry ?? ((): undefined => undefined)
    this.rekeyTabs = deps.rekeyTabs
    this.onCloudIdMinted = deps.onCloudIdMinted
    this.localStore = new LocalDocumentStore(deps.localRootDir)
    // the remote adapter is built once and lives for the process: its per-owner
    // grants and seen versions are exactly the bookkeeping a rebuild would
    // drop from under open tabs. The transport resolves the shared backend
    // client per call, so auth state is always current.
    this.remoteStore = new RemoteDocumentStore({
      transport: deps.transport,
      tempDir: deps.scratchDir,
      onConflict: deps.onConflict,
    })
    this.hybridStore = new HybridDocumentStore(this.localStore, this.remoteStore, {
      onPendingUpload: deps.onPendingUpload,
    })
    // the exit wipe: nothing the scratch space tracked survives a clean exit
    this.remoteStore.scratch.registerExitWipe(deps.onExit ?? ((wipe) => process.on('exit', wipe)))
    this.loadAssociations()
  }

  // ── routing ────────────────────────────────────────────────────────────

  /** The adapter a NEW document routes through: the mode × session matrix. */
  activeStore(): DocumentStore {
    const mode = this.mode()
    if (mode === 'local' || !this.sessionActive()) {
      // local mode, and the logout fallback: an existing local document keeps
      // working (its pinned cloud documents fail their server ops instead —
      // read-only-until-signin, docs/cloud-storage.md)
      return this.localStore
    }
    return mode === 'hybrid' ? this.hybridStore : this.remoteStore
  }

  private intern(path: string): RoutedDoc {
    let doc = this.docs.get(path)
    if (doc === undefined) {
      doc = { ref: { path }, owners: new Set(), scratch: false }
      // a recorded association seeds the id, so a save after a restart updates
      // the same server document instead of minting a duplicate
      const cloudId = this.associations.get(path)
      if (cloudId !== undefined) doc.ref.cloudId = cloudId
      this.docs.set(path, doc)
    }
    return doc
  }

  /**
   * Resolves an op's ref and adapter: the interned handle when this path is
   * routed (so the adapters' cloudId/version bookkeeping sticks), a plain
   * local read for an on-disk file with no server association, and the active
   * adapter otherwise.
   */
  private resolve(ref: DocumentRef): { ref: DocumentRef; store: DocumentStore; doc?: RoutedDoc } {
    const interned = this.docs.get(ref.path)
    if (interned !== undefined) {
      return { ref: interned.ref, store: interned.store ?? this.activeStore(), doc: interned }
    }
    if (ref.cloudId === undefined && !this.associations.has(ref.path) && existsSync(ref.path)) {
      // a real file the server never saw: today's local open/save behavior,
      // even while a cloud mode is active (the first save uploads/mirrors)
      return { ref, store: this.localStore }
    }
    const doc = this.intern(ref.path)
    return { ref: doc.ref, store: doc.store ?? this.activeStore(), doc }
  }

  /**
   * Pins a first-write document to the adapter that just served it, records
   * the minted identity, and fans out re-points.
   */
  private pinAfterCloudOp(doc: RoutedDoc, store: DocumentStore, cloudIdBefore?: string): void {
    if (doc.store === undefined && store !== this.localStore && doc.ref.cloudId !== undefined) {
      // the save created the server copy (first mirror / first remote save):
      // from here on this document belongs to that adapter
      doc.store = store
    }
    const cloudId = doc.ref.cloudId
    if (cloudId === undefined) return
    if (cloudIdBefore === undefined) {
      this.recordAssociation(doc.ref.path, cloudId)
      this.onCloudIdMinted?.(doc.ref.path, cloudId)
    } else if (cloudIdBefore !== cloudId) {
      // the adapter re-pointed the document (404 self-heal or a conflict
      // copy): everything keyed by the old id must follow
      this.associations.set(doc.ref.path, cloudId)
      this.persistAssociations()
      this.registry()?.rekeyDocument(cloudIdBefore, cloudId)
      this.rekeyTabs?.(cloudIdBefore, cloudId)
    }
    if (store !== this.localStore) {
      // the remote adapter keys a grant by the cloud id once one exists, so a
      // mint or re-point silently orphans grants issued under the path key —
      // re-issue every owner's grant under the current identity
      for (const owner of doc.owners) store.authorizeWrite(owner, doc.ref)
    }
  }

  // ── the association index ──────────────────────────────────────────────

  private loadAssociations(): void {
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Partial<StoredIndex>
      if (raw && raw.version === 1 && raw.documents && typeof raw.documents === 'object') {
        for (const [path, entry] of Object.entries(raw.documents)) {
          if (entry && typeof entry.cloudId === 'string' && entry.cloudId !== '') {
            this.associations.set(path, entry.cloudId)
          }
        }
      }
    } catch {
      // missing or corrupt index: every document simply mints a fresh identity
    }
  }

  /** Records path → cloudId, dropping any other path bound to the same id. */
  private recordAssociation(path: string, cloudId: string): void {
    for (const [other, id] of this.associations) {
      // a re-download that landed on a collision-suffixed name must not leave
      // two local files writing the same server document
      if (id === cloudId && other !== path) this.associations.delete(other)
    }
    this.associations.set(path, cloudId)
    this.persistAssociations()
  }

  private persistAssociations(): void {
    const documents: StoredIndex['documents'] = {}
    for (const [path, cloudId] of this.associations) documents[path] = { cloudId }
    try {
      writeIndexFile(this.indexPath, { version: 1, documents })
    } catch (error) {
      console.warn('[storage-mode] failed to persist the document index:', error)
    }
  }

  // ── stored bytes ───────────────────────────────────────────────────────

  async exists(ref: DocumentRef): Promise<boolean> {
    const { ref: resolved, store } = this.resolve(ref)
    return store.exists(resolved)
  }

  async stat(ref: DocumentRef): Promise<DocumentStat> {
    const { ref: resolved, store } = this.resolve(ref)
    return store.stat(resolved)
  }

  async read(ref: DocumentRef): Promise<Buffer> {
    const { ref: resolved, store, doc } = this.resolve(ref)
    const bytes = await store.read(resolved)
    if (doc?.scratch === true && store === this.remoteStore) {
      // the download lands in the scratch file: engines, lazy-media sources
      // and `existsSync` checks want a real file (the honest caveat). Tracked,
      // so the exit wipe and the last-owner cleanup cover it.
      await this.remoteStore.scratch.writeAt(resolved.path, bytes)
    }
    return bytes
  }

  /**
   * Runs one document's write-class op inside that document's queue, so a
   * document's `write` and `writeRecovery` never overlap. Why the router
   * serializes on top of the remote adapter's own per-document PUT chain:
   * each queued op's post-processing must observe the previous op's result
   * in order — a recovery tick bumps the server version the next save guards
   * with, and interleaved bookkeeping (the pin/re-point fan-out, the
   * association persist) would read half-applied state or send the second
   * PUT with a stale `If-Match` (409 → spurious conflict copy + tab re-key).
   */
  private enqueueWrite<T>(path: string, op: () => Promise<T>): Promise<T> {
    const tail = this.writeQueues.get(path) ?? Promise.resolve()
    const result = tail.then(op, op)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    this.writeQueues.set(path, settled)
    void settled.then(() => {
      // drop the queue once it drains (a later enqueue has replaced the entry)
      if (this.writeQueues.get(path) === settled) this.writeQueues.delete(path)
    })
    return result
  }

  write(ref: DocumentRef, bytes: Buffer): Promise<void> {
    return this.enqueueWrite(ref.path, async () => {
      const doc = this.intern(ref.path)
      const store = doc.store ?? this.activeStore()
      const cloudIdBefore = doc.ref.cloudId
      await store.write(doc.ref, bytes)
      if (doc.scratch && store === this.remoteStore) {
        // keep the scratch twin at the saved bytes: lazy media serves ranges
        // from the file at the document's path after a save
        void this.remoteStore.scratch.writeAt(doc.ref.path, bytes).catch(() => {})
      }
      this.pinAfterCloudOp(doc, store, cloudIdBefore)
    })
  }

  async remove(ref: DocumentRef): Promise<void> {
    const { ref: resolved, store, doc } = this.resolve(ref)
    await store.remove(resolved)
    if (doc !== undefined) {
      if (store === this.remoteStore && doc.ref.cloudId !== undefined) {
        // the server copy is gone with the file; the association must not
        // outlive it (the hybrid adapter's remove is deliberately local-only,
        // so its association stays and a reopen re-downloads)
        this.associations.delete(doc.ref.path)
        this.persistAssociations()
      }
      this.dropIfScratch(doc)
    }
  }

  async ensureFolder(ref: DocumentRef): Promise<void> {
    const { ref: resolved, store } = this.resolve(ref)
    await store.ensureFolder(resolved)
  }

  hashBytes(bytes: Buffer): string {
    return this.localStore.hashBytes(bytes)
  }

  /**
   * The local filesystem is the collision authority: downloads and save-as
   * targets are local paths even when the bytes are remote.
   */
  uniquePathIn(dir: string, fileName: string): string {
    return this.localStore.uniquePathIn(dir, fileName)
  }

  // ── write grants ───────────────────────────────────────────────────────

  authorizeWrite(ownerId: number, ref: DocumentRef): void {
    const doc = this.intern(ref.path)
    doc.owners.add(ownerId)
    // the document's adapter is whichever is active at open time; it is kept
    // until the entry is dropped (open tabs keep their store)
    ;(doc.store ?? this.activeStore()).authorizeWrite(ownerId, doc.ref)
  }

  async canWrite(ownerId: number, ref: DocumentRef): Promise<boolean> {
    const { ref: resolved, store } = this.resolve(ref)
    return store.canWrite(ownerId, resolved)
  }

  renameOwnerPath(ownerId: number, oldPath: string, newPath: string): void {
    // the interned handle follows the file (its grants and disk state are
    // re-keyed inside each adapter; the router's key is the path itself)
    const doc = this.docs.get(oldPath)
    if (doc !== undefined) {
      this.docs.delete(oldPath)
      doc.ref.path = newPath
      this.docs.set(newPath, doc)
    }
    if (this.associations.has(oldPath)) {
      this.associations.set(newPath, this.associations.get(oldPath) as string)
      this.associations.delete(oldPath)
      this.persistAssociations()
    }
    this.localStore.renameOwnerPath(ownerId, oldPath, newPath)
    this.remoteStore.renameOwnerPath(ownerId, oldPath, newPath)
  }

  forgetOwner(ownerId: number): void {
    this.localStore.forgetOwner(ownerId)
    this.remoteStore.forgetOwner(ownerId)
    // a remote scratch document dies with its last owner: the tab is closed,
    // the authoritative copy is on the server, and the temp file must go
    for (const doc of [...this.docs.values()]) {
      doc.owners.delete(ownerId)
      if (doc.owners.size === 0) this.dropIfScratch(doc)
    }
  }

  /** Deletes a scratch document's temp file and forgets the routing entry. */
  private dropIfScratch(doc: RoutedDoc): void {
    if (!doc.scratch) return
    this.remoteStore.scratch.remove(doc.ref.path)
    this.docs.delete(doc.ref.path)
  }

  // ── external-change detection ─────────────────────────────────────────

  async recordDiskState(ownerId: number, ref: DocumentRef, hash: string): Promise<void> {
    const { ref: resolved, store } = this.resolve(ref)
    await store.recordDiskState(ownerId, resolved, hash)
  }

  async changedExternally(ownerId: number, ref: DocumentRef): Promise<boolean> {
    const { ref: resolved, store } = this.resolve(ref)
    return store.changedExternally(ownerId, resolved)
  }

  // ── originals archive ──────────────────────────────────────────────────

  async archiveOriginal(ref: DocumentRef, hash: string, size: number): Promise<void> {
    const { ref: resolved, store } = this.resolve(ref)
    await store.archiveOriginal(resolved, hash, size)
  }

  // ── crash-recovery copies (per-mode autosave) ──────────────────────────

  writeRecovery(ref: DocumentRef, bytes: Buffer): Promise<void> {
    // queued behind any in-flight write of the same document (enqueueWrite):
    // the tick's server PUT must not race a save dispatched mid-flight
    return this.enqueueWrite(ref.path, async () => {
      const { ref: resolved, store, doc } = this.resolve(ref)
      if (store === this.remoteStore) {
        // remote mode: the recovery tick IS the server autosave — PUT the
        // bytes as a new version. A crash then reopens the newest server
        // version, so no local buffer is kept (an offline tick fails; the
        // renderer stays dirty and retries — there is no local copy to fall
        // back on).
        const cloudIdBefore = resolved.cloudId
        await this.remoteStore.write(resolved, bytes)
        if (doc !== undefined) this.pinAfterCloudOp(doc, this.remoteStore, cloudIdBefore)
        return
      }
      await store.writeRecovery(resolved, bytes)
    })
  }

  recoveryStamp(ref: DocumentRef): RecoveryStamp | null {
    const resolved = this.resolve(ref)
    return resolved.store.recoveryStamp(resolved.ref)
  }

  async readRecovery(ref: DocumentRef): Promise<Buffer | null> {
    const { ref: resolved, store } = this.resolve(ref)
    return store.readRecovery(resolved)
  }

  recoveryEpoch(ref: DocumentRef): number {
    const resolved = this.resolve(ref)
    return resolved.store.recoveryEpoch(resolved.ref)
  }

  clearRecovery(ref: DocumentRef): void {
    const resolved = this.resolve(ref)
    resolved.store.clearRecovery(resolved.ref)
  }

  sweepRecoveryCopies(ownerId: number): void {
    // every adapter may hold copies for this owner (a document pinned to one
    // adapter may have older copies in another from before a mode switch)
    this.localStore.sweepRecoveryCopies(ownerId)
    this.remoteStore.sweepRecoveryCopies(ownerId)
  }

  // ── path classification (the shell's recents/title seams) ──────────────

  /** True when `path` lives in the remote adapter's ephemeral scratch space. */
  isScratchPath(path: string): boolean {
    return path === this.scratchDir || path.startsWith(`${this.scratchDir}${sep}`)
  }

  /**
   * True when no local file backs `path`: a scratch file, or a document whose
   * persistence is the server (a remote-mode save target). The shell keeps
   * such paths out of the path-keyed recents list — the row would point at a
   * file that never exists.
   */
  isCloudOnlyPath(path: string): boolean {
    if (this.isScratchPath(path)) return true
    return this.docs.get(path)?.store === this.remoteStore
  }

  /**
   * The cached per-file print policy (Ruling 13) of the cloud document bound
   * to `path` — `'allow'` when the path is not cloud-only, has no registry
   * entry, or the entry predates the field. Read at enforcement time (print
   * invocation, menu build), never captured at open, so an owner's toggle
   * applies to an already-open tab. Best-effort fresh: a rate-limited
   * background refresh is kicked fire-and-forget, so a stale cache converges
   * within the registry's auto-refresh window without ever blocking the
   * caller on the network.
   */
  printPolicyForPath(path: string): 'allow' | 'deny' {
    if (!this.isCloudOnlyPath(path)) return 'allow'
    const cloudId = this.docs.get(path)?.ref.cloudId ?? this.associations.get(path)
    if (cloudId === undefined) return 'allow'
    void this.registry()
      ?.autoRefresh()
      .catch(() => {})
    return this.registry()?.document(cloudId)?.printPolicy ?? 'allow'
  }

  // ── open-from-cloud (the home cloud view's row click) ─────────────────

  /**
   * Routes a cloud document open per mode: `remote` pins a scratch path the
   * docs tab loads through; `hybrid`/`local` (both need the session) download
   * to a file under the GenOffice documents folder. No tab is opened here —
   * the IPC layer owns that; this only makes the document loadable.
   */
  async openCloudDocument(cloudId: string): Promise<OpenCloudDocumentOutcome> {
    if (!this.sessionActive()) return { ok: false, error: 'sign-in-required' }
    const entry = this.registry()?.document(cloudId)
    if (entry === undefined) return { ok: false, error: 'not-found' }
    if (!isKnownDocumentKind(entry.kind)) {
      // not one of the six editor kinds (the backend's DOCUMENT_KINDS gate
      // uploads; this guards a registry entry a newer server may carry)
      return { ok: false, error: 'unsupported-kind' }
    }
    const name = documentNameOf(entry.name, entry.kind)
    const mode = this.mode()
    if (mode === 'remote') {
      // the scratch label carries the id (the hash suffix keeps documents
      // with the same file name apart) and the name's extension
      const path = this.remoteStore.scratch.stablePathFor(`${cloudId}/${name}`)
      this.remoteStore.scratch.track(path)
      const doc = this.intern(path)
      doc.ref.cloudId = cloudId
      doc.store = this.remoteStore
      doc.scratch = true
      this.recordAssociation(path, cloudId)
      return {
        ok: true,
        plan: { kind: 'remote', cloudId, path, name, documentKind: entry.kind },
      }
    }
    // hybrid mirrors the download (the pin keeps later saves updating the
    // same server document); local mode just lands a copy — no association
    const store = mode === 'hybrid' ? this.hybridStore : this.localStore
    const download = await this.downloadDocument(cloudId, name, store)
    if (!download.ok) return download
    return {
      ok: true,
      plan: { kind: 'local', path: download.path, name, documentKind: entry.kind },
    }
  }

  /** The cloud identity `path` is already bound to, if any. */
  private boundCloudId(path: string): string | undefined {
    return this.docs.get(path)?.ref.cloudId ?? this.associations.get(path)
  }

  /**
   * A download target free of BOTH collision kinds. `uniquePathIn` is the
   * local filesystem's collision authority only — and a remote-mode save
   * leaves NO file at its document's path, so that phantom path can resurface
   * here while it is still interned (and associated) for a DIFFERENT cloud
   * document. Interning it for this download would overwrite that document's
   * `ref.cloudId` and re-point its association, so the candidates walk the
   * `-2`, `-3`… suffixes until one carries no foreign cloud identity.
   */
  private freshDownloadTarget(dir: string, name: string, cloudId: string): string {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let candidate = this.localStore.uniquePathIn(dir, name)
    for (let n = 2; ; n += 1) {
      const bound = this.boundCloudId(candidate)
      // unbound, or already this document's own target: safe to use
      if (bound === undefined || bound === cloudId) return candidate
      candidate = this.localStore.uniquePathIn(dir, `${stem}-${n}${ext}`)
    }
  }

  /**
   * Downloads one cloud document to the GenOffice documents folder (used by
   * open-from-cloud and the bulk migration). Name collisions get a
   * unique-suffixed local name — on disk AND against paths already bound to
   * another cloud document ({@link freshDownloadTarget}); a document
   * downloaded earlier this session reuses its target while the file still
   * exists (a re-open must not stack up `name-2.docx`, `name-3.docx`…
   * copies).
   */
  async downloadDocument(
    cloudId: string,
    name: string,
    store: DocumentStore = this.localStore,
  ): Promise<{ ok: true; path: string } | { ok: false; error: 'unavailable' }> {
    const dir = this.documentsDir()
    // a document downloaded earlier this session reuses its target while the
    // file still exists (a re-open must not stack up `name-2.docx`,
    // `name-3.docx`… copies — and a vanished file must not be overwritten,
    // which a bare truthiness check on the promise would silently allow)
    let target = this.downloadTargets.get(cloudId)
    if (target === undefined || !(await this.localStore.exists({ path: target }))) {
      target = this.freshDownloadTarget(dir, name, cloudId)
    }
    try {
      if (store === this.localStore) {
        // local mode: a plain copy, no mirror association (a throwaway ref —
        // interning would pin a cloud id onto a local-mode document)
        const bytes = await this.remoteStore.read({ path: `${cloudId}/${name}`, cloudId })
        await this.localStore.ensureFolder({ path: target })
        await this.localStore.write({ path: target }, bytes)
      } else {
        // hybrid: read through the pinned ref so the download lands AND later
        // saves mirror back to the same server document
        const doc = this.intern(target)
        doc.ref.cloudId = cloudId
        doc.store = store
        await store.read(doc.ref)
        this.recordAssociation(target, cloudId)
      }
    } catch (error) {
      console.warn('[storage-mode] cloud document download failed:', error)
      return { ok: false, error: 'unavailable' }
    }
    this.downloadTargets.set(cloudId, target)
    return { ok: true, path: target }
  }

  /**
   * Uploads one local document to the server (the bulk migration's unit):
   * read from disk, write through the active adapter — which pins the path,
   * so a doc that is open in a tab keeps updating the copy just created. In
   * hybrid mode only the mirror is sent: the working copy is already the file
   * on disk, and rewriting it would trip the open tab's external-change check.
   */
  async uploadDocument(path: string): Promise<void> {
    const bytes = await this.localStore.read({ path })
    const doc = this.intern(path)
    const store = doc.store ?? this.activeStore()
    const cloudIdBefore = doc.ref.cloudId
    if (store === this.hybridStore) {
      await this.remoteStore.write(doc.ref, bytes)
    } else {
      await store.write(doc.ref, bytes)
    }
    this.pinAfterCloudOp(doc, store, cloudIdBefore)
  }

  // ── scratch lifecycle ──────────────────────────────────────────────────

  /** Wipes every tracked scratch file (the shell's clean-exit hook). */
  async wipeScratch(): Promise<void> {
    await this.remoteStore.scratch.cleanupAll()
  }

  /**
   * Deletes the whole scratch directory (best effort) — the startup sweep for
   * files a crashed run left behind, before anything is tracked this session.
   * Call only once no other instance can hold the space open (after the
   * single-instance lock).
   */
  sweepStaleScratch(): void {
    try {
      rmSync(this.scratchDir, { recursive: true, force: true })
    } catch {
      // an unreadable temp dir must never block startup
    }
  }

  /** The scratch directory the remote adapter writes into. */
  get scratchDirPath(): string {
    return this.scratchDir
  }
}

/**
 * The backend's document kinds (services/backend DOCUMENT_KINDS, mirrored in
 * shared/cloud-docs-api.ts) and the file extensions each maps to. `md` also
 * accepts `.markdown` and `html` accepts `.htm`, matching the editors' own
 * file filters; the first extension is the canonical one appended when the
 * server name carries none of them.
 */
const KIND_EXTENSIONS: Record<string, readonly [primary: string, ...accepted: string[]]> = {
  docx: ['.docx'],
  xlsx: ['.xlsx'],
  pptx: ['.pptx'],
  pdf: ['.pdf'],
  md: ['.md', '.markdown'],
  html: ['.html', '.htm'],
}

function isKnownDocumentKind(kind: string): boolean {
  return KIND_EXTENSIONS[kind] !== undefined
}

/**
 * A cloud document's local file name: the server name is user data, the
 * editor kind decides the extension (a name already carrying one of the
 * kind's extensions is kept verbatim, a bare name gets the primary one).
 */
function documentNameOf(name: string, kind: string): string {
  const extensions = KIND_EXTENSIONS[kind] ?? ['.bin']
  const trimmed = name.trim()
  if (trimmed === '') return `document${extensions[0]}`
  const lower = trimmed.toLowerCase()
  if (extensions.some((ext) => lower.endsWith(ext))) return trimmed
  return `${trimmed}${extensions[0]}`
}

/**
 * Atomic write (tmp + rename), synchronous like the remote project adapter's
 * `writeIndexFile` (packages/project-store — this index's project twin): the
 * callers include synchronous contract methods (`renameOwnerPath`), and an
 * association must be durable by the time the routing op resolves — a floating
 * write would also race the app's quit teardown. A failed write degrades to
 * the loadAssociations path (documents mint fresh identities), never thrown.
 */
function writeIndexFile(path: string, index: StoredIndex): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8')
  renameSync(tmpPath, path)
}
