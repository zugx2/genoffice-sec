# Cloud document storage — implementation notes

Working notes for the `DocumentStore` adapters in
`packages/document-store` (`local` / `remote` / `hybrid`,
docs/cloud-backend-auth.md "Document storage modes"). This file records the
known gaps that are deliberately NOT solved by the adapter tasks, so they
are not rediscovered at rollout.

## Adapters (Phase 7c)

| Adapter               | File                                    | Persistent copy                             | Conflict policy                                                                                     |
| --------------------- | --------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `LocalDocumentStore`  | `packages/document-store/src/local.ts`  | the local file                              | mtime/size/hash external-change check                                                               |
| `RemoteDocumentStore` | `packages/document-store/src/remote.ts` | the server only (ephemeral scratch on disk) | stale `If-Match` → `?conflict=copy`, ref re-pointed + `conflicted` flag                             |
| `HybridDocumentStore` | `packages/document-store/src/hybrid.ts` | the local file, mirrored on every save      | the remote half's policy; a failed mirror is recorded (`pendingUploads`), never a failed local save |

Routing between them (the `storageMode` setting, guards, mode-switch
migration) is a later task; the shell installs an adapter through
`setDocumentStore` in `apps/docs/src/main/docs-main.ts`.

## TODO before rollout: lazy-media reads the file off disk on open

**`openLazyDocx`** (`apps/docs/src/main/lazy-media.ts`) opens the document
by real path — `openZipFile(filePath)`, `sha256File(filePath)` — and
registers that path as the lazy-media source for the placeholders it cuts
into the slim copy. Under `remote` storage there is no such file: the open
path downloads bytes into memory, so the optimization either has to be
skipped (read the whole document, as `openLazyDocx`'s own null path already
does for small media) or fed from an ephemeral scratch file
(`RemoteDocumentStore.scratch`) whose path is then registered as the media
source. Under `hybrid` the working copy exists, but a document opened
straight from the cloud before its local file lands hits the same hole.

This must be addressed when a storage mode actually routes a docs open
(Phase 7 rollout task): the read then goes through `DocumentStore.read`,
and `registerSource`/`forgetLazyMediaOwner` key off a path that only the
local and hybrid adapters can honor. Until then every cloud-routed open
would silently take the whole-file path or fail the media lookup.

Related, same rollout: `renameOwnerPath` is a local-filesystem re-key with
no server counterpart — renaming a cloud document alongside a local rename
(a hybrid save-as, a shell rename hook) needs a server-side rename/metadata
decision before hybrid mode can mirror renames.

## TODO tie-in (Phase 7d): cloudId re-points must reach the registry + tabs

The adapter already re-points a document's cloud id silently (404 self-heal
recreates the mirror; `?conflict=copy` stores the copy as a new document),
but nothing else learns the new id. The shell-side contract is in place and
waits on the storageMode wiring (Task 16):

- `CloudDocumentsRegistry.onDocumentRekeyed(old, new)`
  (`apps/shell/src/main/auth/cloud-docs.ts`) — subscribe and re-key your own
  state; the tab manager exposes `rekeyTabCloudId` for exactly this.
- `CloudDocumentsRegistry.rekeyDocument(old, new)` — call it for each
  re-point so the registry's cache entry and its queued (offline) stars
  follow, and the event fans out to every other subscriber.

Until that wiring lands, the registry self-corrects on the next successful
refresh (the server list is keyed by the new id), but open tabs and the
star queue would keep a dead id — hook the adapter's re-point paths into
these two seams when connecting `setDocumentStore`.
