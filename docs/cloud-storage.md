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
through `setDocumentStore` in `apps/docs/src/main/docs-main.ts` — and, since
Phase 7f, through the per-editor twins (`setSheetsDocumentStore`,
`setSlidesDocumentStore`, `setPdfDocumentStore`, `setMarkdownDocumentStore`,
`setHtmlDocumentStore`), so all six editors route their open/save/recovery
handlers through the router. See "Per-editor rollout (Phase 7f)" below.

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

## Per-editor rollout (Phase 7f)

The docs pilot's rules now hold for every editor: startup injection of the
router (`set<Editor>DocumentStore(getDocumentStoreRouter())` in the shell,
a plain `LocalDocumentStore` in standalone mode), re-resolve per operation,
open tabs keep their pinned adapter, and open-from-cloud rows of every kind
open in their editor (the router's `openCloudDocument` dispatches on the
registry `kind`; the shell's `openCloudTabForKind` maps kind → tab opener,
with the same cloudId-keyed tabs in `remote` and download + path-keyed tabs
in `hybrid`/`local` as docs got in 7e). Guard parity is structural: a save
can only reach the store's write path, and the MCP silent-save grants
(docs `authorizeMcpDocWrite`, sheets `authorizeMcpSheetWrite`, slides
`saveSessionDeckTo`, markdown/html `saveToPath`) record owners through
`authorizeWrite`, so a remote-routed document's write PUTs through its
pinned adapter and never touches disk behind the router's back.

What each editor routes, and where its file-backed machinery remains:

| Editor   | Routed through the store                                                                                                                             | Still file-backed (by design)                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| docs     | open/save/save-as/save-new/save-to/recovery (pilot, 7e)                                                                                              | lazy media reads the scratch twin                                                                                                                                        |
| sheets   | session snapshot at open, save (bytes pushed after the sidecar lands them), recovery copies, csv import source, MCP target grants                    | the sidecar itself (it opens and writes real files; the store materializes its inputs and ships its outputs); in-place CSV saves stay local (`.csv` is not a cloud kind) |
| slides   | open reads, save/save-as/save-to, AI drafts, crash-recovery copies                                                                                   | nothing byte-moving                                                                                                                                                      |
| pdf      | routed open read, save, in-place page ops (insert/replace/resize/crop), all document reads (previews, page images, form fills, text-edit validation) | since Ruling 13 the export-to-NEW-file paths are gated (see "Ruling 13" below), not removed; they remain plain local artifacts for local/hybrid documents                |
| markdown | open read, save/save-as                                                                                                                              | asset files beside the document (scratch-relative for remote docs)                                                                                                       |
| html     | open read, save/save-as                                                                                                                              | same asset story as markdown                                                                                                                                             |

Notes and residuals, all rooted in the same honest caveats as before:

- **Sheets/slides recovery buffers moved into the store.** The copies now
  live in the store's per-mode autosave layout instead of
  `sheets-autosave/` / `slides-autosave/` (those directories survive only as
  the sidecar's staging path in sheets). Semantics are unchanged for
  local/hybrid (mtime-newer copy → Restore/Discard offer; save or explicit
  discard clears it); a remote-routed document has no local copy at all —
  its recovery tick IS the server autosave, and a reopen downloads the
  newest version, so there is nothing to offer as "recovered". Copies
  written by older builds in the old directories are simply orphaned.
- **Sheets' external-change guard is sha-based on the local file.** For a
  remote-routed document the session's path is an ephemeral scratch file the
  sidecar itself wrote, so the sha guard compares against that file (a
  missing file never blocks a save); cross-device conflicts are handled by
  the server's `If-Match` version checks on the routed write, not by the
  local sha.
- **A sheets/slides save lands its bytes on disk first** (the sidecar
  writes `targetPath`, `savePptx` bytes are written by the routed write) and
  is then pushed through the store — so in `local` mode a save writes the
  same bytes twice (sidecar output, then the local adapter's atomic rewrite
  of identical bytes). Deliberate: it keeps every byte movement on one
  routing path instead of special-casing modes inside the editors.
- **PDF feature reads go through the store**, so previews and page images of
  a remote-routed document read the same bytes the editor opened (the
  router's `read` materializes the scratch twin). After a save the twin is
  refreshed fire-and-forget (the 7e note above), so a feature read in the
  moments between can still see the pre-save bytes until the next routed
  read.
- **markdown/html image assets are ordinary files beside the document.** For
  a remote scratch document they land in the scratch space and share its
  lifecycle; the asset protocol serves them from the document's directory,
  which is the scratch directory there.
- **Slides keeps its own `File > Open Recent` menu** (`slides-recent.json`)
  beside the home screen's recents; it installs the same
  `isCloudOnlyPath` filter (`setSlidesRecentPathFilter`) so a remote-routed
  deck's ephemeral path never grows a row there either.

## Ruling 13: cloud-only exports are flat-blocked; printing is a per-file policy

User ruling (2026-09-27): **files open from the secure cloud must not be
exportable**, amended to keep **printing available** with printing
restrictions as a **per-file policy** instead. Shipped shape:

- **Export block.** Every flow that writes document-derived bytes of a
  CLOUD-ONLY document (the router's `isCloudOnlyPath()`: remote-mode pinned
  docs and scratch files — never hybrid/local) to a NEW local file answers a
  typed `export-blocked` at the handler and its application-menu item
  disables while the tab is active. Two layers on purpose: the menu is the
  visible half (the app menu rebuilds per tab switch, so `enabled` follows
  the active tab), the handler is the enforcement (invocation-time, so a
  stale menu item still cannot leak). Per editor:
  docs `export-pdf`/`export-html`/`save-merged-pdf`/`write-export-image`/
  `save-image-as`; pdf `extract-pages`/`split-pdf`/`merge-pdf`/
  `merge-pages`/`export-images`/redaction copy, plus the shell's
  docx/pptx/xlsx converters and the shell's pdf Save As (its no-pending-edits
  branch is a verbatim local copy); sheets `export-pdf`/`export-csv`; slides
  `export-images`/`export-pdf` (destination dialogs refuse first, so they
  never open for a cloud-only deck); markdown `export-pdf`/`export-docx`
  (dialog AND open-in-Docs modes — the conversion-cache docx would open as an
  ordinary ungated local Docs tab)/`save-image-as`;
  html `export-docx`/`export-pdf`/`export-html`. The shell injects one gate
  object into all six editors (`set<Editor>CloudGate`) built from the router
  predicate plus the registry's cached print policy; standalone apps
  register none and never block.
- **Per-file print policy.** `document_meta.print_policy` on the server
  (`'allow'` default | `'deny'`; `PUT /documents/:id/print-policy`, owner-
  scoped, enum-validated, deliberately version-bump-free like the other
  meta writes), carried through the registry snapshot to the cloud view's
  printer toggle (one per row; the optimistic edit REVERTS on a failed
  write — a governance toggle is never offline-queued like a star).
  `DocumentStoreRouter.printPolicyForPath()` reads the LIVE cache at print
  invocation — never captured at open, so an owner's flip applies to an
  already-open tab — and kicks the rate-limited auto-refresh, so a policy
  flipped elsewhere converges within ~30 s. Enforcement points: docs/
  sheets/slides inside their print handlers (typed `print-blocked`), pdf
  via a `pdf:print-gate` invoke the renderer consults before opening its
  print dialog (toolbar button and ⌘P included), markdown/html at the
  main-side print senders (their only menu-driven entry points), with the
  menu item disabled on deny everywhere.
- **Not gated, deliberately:** saves and save-as in the path-keyed editors
  (docs/sheets/slides/markdown/html — in remote mode they upload; pdf's Save
  As is the exception above: its clean-copy branch never uploaded, it
  verbatim-copied, so pdf Save As is gated for cloud-only documents);
  hybrid/local documents (an authoritative local copy already exists); MCP
  save-to flows (store-routed: in remote mode they mint new server
  documents, no local file); screenshots and clipboard copies (out of scope,
  see below).

**Honest limits — this is data governance, not DRM.** The policy is
enforced by the shipped clients. A modified client, a user with raw API
access to their OWN data (`GET /documents/:id` is and must remain available
to the owner's own signed-in client), or a screenshot/copy-paste bypasses
all of it. There is no watermarking, no server-side kill switch, and no
screenshot defense: the block removes the one-click "save a copy" paths and
makes the restriction visible and owner-managed, nothing more.

One residual is recorded for completeness: in remote mode, a save-as (or
`docs:save-to`, or a sheets MCP save) aimed at an EXISTING local path with
no server association writes LOCALLY — the router resolves an existing
unbound path through the local adapter
(`document-store-router.ts` `resolve()`: a real file the server never saw
stays local, even while a cloud mode is active). The bytes therefore land
on disk without an upload; they do stay under the user's own account and
machine, and a save to a NEW path mints a server document as intended.
