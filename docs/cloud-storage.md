# Cloud document storage — implementation notes

Working notes for the `DocumentStore` adapters in
`packages/document-store` (`local` / `remote` / `hybrid`,
docs/cloud-backend-auth.md "Document storage modes"). This file records the
known gaps that are deliberately NOT solved by the adapter tasks, so they are
not rediscovered at rollout.

## Adapters (Phase 7c)

| Adapter               | File                                    | Persistent copy                             | Conflict policy                                                                                     |
| --------------------- | --------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `LocalDocumentStore`  | `packages/document-store/src/local.ts`  | the local file                              | mtime/size/hash external-change check                                                               |
| `RemoteDocumentStore` | `packages/document-store/src/remote.ts` | the server only (ephemeral scratch on disk) | stale `If-Match` → `?conflict=copy`, ref re-pointed + `conflicted` flag                             |
| `HybridDocumentStore` | `packages/document-store/src/hybrid.ts` | the local file, mirrored on every save      | the remote half's policy; a failed mirror is recorded (`pendingUploads`), never a failed local save |

Routing between them is the shell's `documentStoreRouter`
(`apps/shell/src/main/auth/document-store-router.ts`, Phase 7e), installed
through `setDocumentStore` in `apps/docs/src/main/docs-main.ts` — see below.

## Routing (Phase 7e, the storageMode rollout)

The router picks the adapter per operation from `(storageMode, session)`:

| Mode              | Session | Adapter | Notes                                      |
| ----------------- | ------- | ------- | ------------------------------------------ |
| `local`           | either  | local   | today's behavior, unchanged                |
| `remote`          | live    | remote  | the server is the only persistent copy     |
| `hybrid`          | live    | hybrid  | local working copy + upload-on-save mirror |
| `remote`/`hybrid` | none    | local   | the logout fallback (see below)            |

Decisions recorded here so they are not re-litigated:

- **Open tabs keep their store.** The ruling says the docs editor gets its
  store "at startup AND on mode/session changes — re-resolve; open tabs keep
  their current store until closed". A module-global `setDocumentStore` swap
  cannot honor the second half (every open tab shares the installed store),
  so the router is installed once and pins the adapter per document: the
  first cloud op on a path (a save that mints the server copy, a cloud-open
  download) pins it, later ops keep the pin until the entry is dropped (tab
  close for a remote scratch document). A mode switch therefore affects new
  opens and the opt-in migration, never an open document mid-flight.
- **Logout fallback.** On sign-out while the mode is remote/hybrid the
  SETTING stays (nothing clears it); routing falls back to local behavior
  for local documents (the hybrid half of a pinned hybrid document IS local
  behavior, so its saves keep landing locally and a failed mirror turns into
  a recorded pending upload). A document pinned to the remote adapter has no
  local copy to fall back on, so its saves fail — cloud documents are
  read-only-until-signin, and opening one (`cloud:open-document`) answers
  the typed `sign-in-required` the renderer surfaces.
- **The path → cloudId association persists** in
  `userData/cloud-document-index.json` (the document twin of the remote
  project adapter's index). Without it, the first save after an app restart
  would mint a SECOND server document for a file that already has one —
  every hybrid doc would fork its version history once per session. Only
  the id is stored, never the version: a stale `If-Match` turns a benign
  cross-session save into a conflict copy, while no version makes it a
  plain last-writer-wins upload. In `local` mode the association is ignored
  but kept, so switching back to hybrid resumes the same server document.
- **Plain local files still open in cloud modes.** File > Open, the recents
  rows, and the folder tree are path-keyed, and a user switching modes still
  has files on disk. An uninterned path with a real file and no recorded
  association reads/writes through the local adapter; its first save then
  uploads/mirrors per the active mode (remote mode's upload-on-save). Paths
  WITH an association follow the mode instead — in `remote` the server is
  authoritative even when a stale local file exists.
- **Remote-routed paths stay out of the local recents list** (docs-main's
  `setRecentPathFilter` seam + the shell's opened hook): a remote document's
  path is either an ephemeral scratch file or a server-side label, so a
  recents row would point at a file that never exists; the home cloud view
  (keyed by cloudId) is its surface.
- **Per-mode autosave.** Remote-routed `writeRecovery` IS the server
  autosave — the recovery tick PUTs a new version and writes no local buffer
  (a reopen downloads the newest version, so there is nothing to offer as
  "recovered"; an offline tick fails and the renderer stays dirty). Local
  and hybrid documents keep today's recovery-buffer semantics. The scratch
  space is wiped on clean exit (`registerExitWipe` on `will-quit`) and swept
  at startup (`sweepStaleScratch`, after the single-instance lock), so a
  crashed run's leftovers do not accumulate.
- **Migration is opt-in and directional.** `local → hybrid/remote` offers a
  bulk upload (every uploadable document under the GenOffice documents
  folder, sequential, progress-pushed, failures listed and retryable);
  `remote → local/hybrid` offers a bulk download (unique-suffixed names on
  collision). `hybrid → anything` offers nothing — the working copies are
  already local and mirrored. A hybrid upload step mirrors only (the local
  file is already the working copy; rewriting it would trip an open tab's
  external-change check).

Known edges (deliberately open, all rooted in path-keyed surfaces):

- **Lazy media in `remote` mode.** `openLazyDocx` reads the file at the
  document's path. For a cloud open the router's `read`/`write` keep the
  tracked scratch twin at the current bytes, so the scratch path is a valid
  media source — but a path-keyed open of a LOCAL file in remote mode
  (`exists` wins locally, then the association routes the read to the
  server) can pair server bytes with the local file's lazy media when the
  two have diverged. Rare (needs lazy-sized media + a diverged copy + a
  tree open in remote mode); reopen from the cloud view to realign.
- **`renameOwnerPath` is still local-only**: renaming a cloud document
  alongside a local rename (a hybrid save-as, a shell rename hook) needs a
  server-side rename/metadata decision before hybrid mode can mirror
  renames (the router re-keys the association index; the server keeps the
  old name).
- **The `remote → local/hybrid` download offer counts only the registry's
  cached list**; a never-synced registry shows "nothing to move" until the
  next refresh.

## Tie-in (Phase 7d → wired in 7e): cloudId re-points reach the registry + tabs

The adapter re-points a document's cloud id silently (404 self-heal
recreates the mirror; `?conflict=copy` stores the copy as a new document).
The storage-mode wiring closes the loop: the router diffs the ref's id
before/after every cloud op and calls `CloudDocumentsRegistry.rekeyDocument`
(so the cache entry and queued stars follow) plus the tab manager's
`rekeyTabCloudId` (open tabs follow); the registry's own
`onDocumentRekeyed` subscribers reach the tabs through the same seam.
