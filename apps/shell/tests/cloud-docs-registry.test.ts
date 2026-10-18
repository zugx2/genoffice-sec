/**
 * CloudDocumentsRegistry (src/main/auth/cloud-docs.ts, Phase 7d): the
 * main-process cache of the server document list. Electron-free by
 * construction — the backend client and the session are seams — so this
 * suite drives both with fakes and asserts the observable contract:
 *
 * - cache/refresh: `snapshot()` serves the cache instantly and never
 *   touches the network; `refresh()` re-fetches through the shared client
 *   and is single-flight;
 * - stale flag: a failed refresh keeps the last-known list and raises
 *   `stale`; the next successful refresh clears it;
 * - star queue: a toggle that cannot be delivered is applied locally and
 *   replayed on the next refresh (server last-write-wins), including
 *   surviving a restart through the persisted cache;
 * - account binding: the cache file is keyed by a salted hash of `sub`, and
 *   another account's cache is dropped, never served;
 * - `onDocumentRekeyed` / `rekeyDocument`: the Task 14 carry-over contract.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloudDocumentsRegistry,
  cloudDocsOwner,
  MIN_AUTO_REFRESH_MS,
} from '../src/main/auth/cloud-docs'
import type { BackendClient } from '../src/main/auth/backend-client'

/** A scripted backend surface: the shared client's fetch, results scripted per test. */
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const DOC = (id: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id,
  name: `${id}.md`,
  kind: 'md',
  size: 12,
  currentVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  starred: false,
  lastOpenedAt: null,
  ...over,
})

let dir: string
let storePath: string
let sub: string | null
const clock = vi.fn((): number => 1_700_000_000_000)

function makeRegistry(options: { client?: () => Promise<BackendClient> | undefined } = {}) {
  return new CloudDocumentsRegistry({
    client: options.client ?? (async () => undefined),
    session: { currentSub: () => sub },
    storePath,
    now: clock,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloud-docs-registry-'))
  storePath = join(dir, 'cloud-documents.json')
  sub = 'user-a'
  clock.mockReturnValue(1_700_000_000_000)
  fetchMock = vi.fn()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('owner tag', () => {
  it('hashes the sub with a fixed salt (never stores the sub itself)', () => {
    expect(cloudDocsOwner('user-a')).not.toBe('user-a')
    expect(cloudDocsOwner('user-a')).toBe(cloudDocsOwner('user-a'))
    expect(cloudDocsOwner('user-a')).not.toBe(cloudDocsOwner('user-b'))
  })
})

describe('snapshot (cache, no network)', () => {
  it('is unavailable until a list was synced for the current account', async () => {
    const registry = makeRegistry()
    expect(registry.snapshot()).toEqual({
      available: false,
      documents: [],
      syncedAt: 0,
      stale: false,
      pendingStars: 0,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves the refreshed list and the sync timestamp without refetching', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    const first = await registry.refresh()
    expect(first).toMatchObject({ available: true, stale: false, syncedAt: 1_700_000_000_000 })
    expect(first.documents).toHaveLength(1)
    expect(first.documents[0]).toMatchObject({ cloudId: 'doc-1', name: 'doc-1.md', kind: 'md' })

    fetchMock.mockClear()
    const cached = registry.snapshot()
    expect(cached).toMatchObject({ available: true, stale: false })
    expect(cached.documents[0].cloudId).toBe('doc-1')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(registry.document('doc-1')?.name).toBe('doc-1.md')
    expect(registry.document('missing')).toBeUndefined()
  })

  it('coalesces concurrent refreshes into one request (single-flight)', async () => {
    let release: ((value: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    fetchMock.mockReturnValue(pending)
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    const a = registry.refresh()
    const b = registry.refresh()
    release!(jsonResponse(200, { documents: [DOC('doc-1')] }))
    const [sa, sb] = await Promise.all([a, b])
    expect(sa.available).toBe(true)
    expect(sb.available).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a malformed list body without clearing the cache', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { nope: true }))
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    // seed a good cache first
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    expect(registry.snapshot().available).toBe(true)

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { nope: true }))
    await registry.refresh()
    // the bad body is treated as a failed refresh: cache kept, stale raised
    expect(registry.snapshot()).toMatchObject({ available: true, stale: true })
  })
})

describe('stale flag (offline)', () => {
  it('keeps the last-known list behind the stale flag when a refresh fails', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await registry.refresh()
    const stale = registry.snapshot()
    expect(stale).toMatchObject({ available: true, stale: true })
    expect(stale.documents[0].cloudId).toBe('doc-1')

    // recovery: the next successful refresh clears the flag
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    expect(registry.snapshot().stale).toBe(false)
  })

  it('treats a client that cannot be built as offline, not as empty', async () => {
    const registry = makeRegistry({ client: async () => undefined })
    fetchMock.mockResolvedValue(jsonResponse(200, { documents: [DOC('doc-1')] }))
    const snapshot = await registry.refresh()
    expect(snapshot).toEqual({
      available: false,
      documents: [],
      syncedAt: 0,
      stale: false,
      pendingStars: 0,
    })
  })

  it('serves nothing once the session ends (no cross-account leakage)', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    expect(registry.snapshot().available).toBe(true)

    sub = null
    expect(registry.snapshot().available).toBe(false)
    expect(registry.document('doc-1')).toBeUndefined()
    // and the same for a different account's sub (cache is owner-tagged)
    sub = 'user-b'
    expect(registry.snapshot().available).toBe(false)
  })
})

describe('star queue (offline toggle, replayed on refresh)', () => {
  function registryWithClient() {
    return makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
  }

  it('delivers a star immediately when online', async () => {
    const registry = registryWithClient()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { starred: true }))
    const snapshot = await registry.toggleStarred('doc-1', true)
    expect(snapshot.documents[0].starred).toBe(true)
    expect(snapshot.pendingStars).toBe(0)
    expect(fetchMock).toHaveBeenLastCalledWith('/documents/doc-1/starred', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    })
  })

  it('queues a star that cannot be delivered and replays it on the next refresh', async () => {
    const registry = registryWithClient()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()

    // offline: the PUT throws
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const queued = await registry.toggleStarred('doc-1', true)
    // applied locally (the optimistic flag) and reported as pending
    expect(queued.documents[0].starred).toBe(true)
    expect(queued.pendingStars).toBe(1)

    // back online: the refresh replays the queued PUT before listing, and
    // the freshly fetched list already reflects the delivered star
    const replayThenList = async (path: string): Promise<Response> =>
      path.endsWith('/starred')
        ? jsonResponse(200, { starred: true })
        : jsonResponse(200, { documents: [DOC('doc-1', { starred: true })] })
    fetchMock.mockImplementationOnce(replayThenList)
    fetchMock.mockImplementationOnce(replayThenList)
    const refreshed = await registry.refresh()
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/documents/doc-1/starred', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    })
    expect(refreshed.pendingStars).toBe(0)
    expect(refreshed.documents[0].starred).toBe(true)
  })

  it('a pending local toggle wins over the last-known server state until delivered', async () => {
    const registry = registryWithClient()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { documents: [DOC('doc-1', { starred: false })] }),
    )
    await registry.refresh()

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await registry.toggleStarred('doc-1', true)

    // the replay attempt fails server-side (the toggle is still undelivered):
    // the refresh goes stale, the cache keeps the server's `false`, and the
    // snapshot still shows the user's local `true` on top of it
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: { code: 'internal' } }))
    const snapshot = await registry.refresh()
    expect(snapshot.stale).toBe(true)
    expect(snapshot.documents[0].starred).toBe(true)
    expect(snapshot.pendingStars).toBe(1)
  })

  it('replaces an earlier queued toggle for the same document (no stale writes)', async () => {
    const registry = registryWithClient()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    fetchMock.mockRejectedValue(new Error('offline'))
    await registry.toggleStarred('doc-1', true)
    const twice = await registry.toggleStarred('doc-1', false)
    expect(twice.pendingStars).toBe(1)
    expect(twice.documents[0].starred).toBe(false)
  })

  it('drops a queued star whose document was deleted server-side (404)', async () => {
    const registry = registryWithClient()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await registry.toggleStarred('doc-1', true)

    fetchMock.mockImplementation(async (path: string) =>
      path.endsWith('/starred')
        ? jsonResponse(404, { error: { code: 'not_found' } })
        : jsonResponse(200, { documents: [] }),
    )
    const refreshed = await registry.refresh()
    expect(refreshed.pendingStars).toBe(0)
    expect(refreshed.documents).toEqual([])
  })

  it('ignores a toggle for a document not in the cache', async () => {
    const registry = registryWithClient()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    const snapshot = await registry.toggleStarred('unknown-doc', true)
    expect(snapshot.pendingStars).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1) // the list fetch only
  })

  it('persists cache + queue, and both survive a restart', async () => {
    const registry = registryWithClient()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await registry.toggleStarred('doc-1', true)
    registry.dispose()
    expect(existsSync(storePath)).toBe(true)

    // a fresh instance over the same file (the app restarted offline)
    const revived = registryWithClient()
    const snapshot = revived.snapshot()
    expect(snapshot.available).toBe(true)
    expect(snapshot.documents[0].starred).toBe(true)
    expect(snapshot.pendingStars).toBe(1)
  })

  it('drops another account’s persisted cache instead of serving it', async () => {
    const registry = registryWithClient()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    sub = 'user-b'
    const other = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    expect(other.snapshot().available).toBe(false)
    expect(existsSync(storePath)).toBe(false)
    // and the stored owner tag is the sub hash, never the sub
    void registry
  })
})

describe('markOpened', () => {
  it('stamps the open server-side and syncs the cached lastOpenedAt', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { lastOpenedAt: '2026-02-03T00:00:00.000Z' }))
    await registry.markOpened('doc-1')
    expect(fetchMock).toHaveBeenCalledWith('/documents/doc-1/opened', { method: 'POST' })
    expect(registry.document('doc-1')?.lastOpenedAt).toBe('2026-02-03T00:00:00.000Z')
  })

  it('never throws — an unrecorded open is only an older stamp', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(registry.markOpened('doc-1')).resolves.toBeUndefined()
  })
})

describe('onDocumentRekeyed (Task 14 carry-over)', () => {
  it('re-keys the cache entry and the queued stars, and notifies subscribers', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await registry.toggleStarred('doc-1', true)

    const seen: Array<[string, string]> = []
    registry.onDocumentRekeyed((oldId, newId) => seen.push([oldId, newId]))

    registry.rekeyDocument('doc-1', 'doc-2')
    expect(seen).toEqual([['doc-1', 'doc-2']])
    expect(registry.document('doc-1')).toBeUndefined()
    expect(registry.document('doc-2')?.starred).toBe(true)
    // the queued star followed the new id
    fetchMock.mockImplementation(async (path: string) =>
      path.endsWith('/starred')
        ? jsonResponse(200, { starred: true })
        : jsonResponse(200, { documents: [] }),
    )
    const refreshed = await registry.refresh()
    expect(refreshed.pendingStars).toBe(0)
  })

  it('is a no-op for an unknown old id (nothing to re-key)', () => {
    const registry = makeRegistry()
    const seen: Array<[string, string]> = []
    registry.onDocumentRekeyed((oldId, newId) => seen.push([oldId, newId]))
    registry.rekeyDocument('unknown', 'doc-2')
    expect(seen).toEqual([])
  })

  it('unsubscribe stops the notifications', () => {
    const registry = makeRegistry()
    const seen: Array<[string, string]> = []
    const off = registry.onDocumentRekeyed((oldId, newId) => seen.push([oldId, newId]))
    off()
    registry.rekeyDocument('a', 'b')
    expect(seen).toEqual([])
  })
})

describe('change events', () => {
  it('fire on refresh and star, with the reason', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    const reasons: string[] = []
    registry.onChange((reason) => reasons.push(reason))

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { starred: true }))
    await registry.toggleStarred('doc-1', true)
    expect(reasons).toEqual(['refreshed', 'starred'])
  })

  it('do not fire when a refresh changed nothing (syncedAt alone is not a change)', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    const reasons: string[] = []
    registry.onChange((reason) => reasons.push(reason))

    // first sync: empty → one document, a real change
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    expect(reasons).toEqual(['refreshed'])

    // second sync returns the identical list: nothing to announce
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    expect(reasons).toEqual(['refreshed'])

    // a genuine server-side change does announce
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { documents: [DOC('doc-1', { name: 'renamed.md' })] }),
    )
    await registry.refresh()
    expect(reasons).toEqual(['refreshed', 'refreshed'])
  })
})

describe('autoRefresh (the renderer-driven kick, rate-limited)', () => {
  const T = 1_700_000_000_000

  it('fetches on the first kick, then skips within the interval — no list→push→list loop', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    clock.mockReturnValue(T)
    fetchMock.mockResolvedValue(jsonResponse(200, { documents: [DOC('doc-1')] }))

    await registry.autoRefresh()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // the push the section answers with makes it list again — that second
    // kick must NOT fetch: same data, within the interval
    await registry.autoRefresh()
    await registry.autoRefresh()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // after the interval the kick fetches again
    clock.mockReturnValue(T + MIN_AUTO_REFRESH_MS)
    await registry.autoRefresh()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips the interval gate while stale (a failed sync retries on the next kick)', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    clock.mockReturnValue(T)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.autoRefresh()

    // past the interval the kick runs again and the sync fails → stale
    clock.mockReturnValue(T + MIN_AUTO_REFRESH_MS)
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await registry.autoRefresh()
    expect(registry.snapshot().stale).toBe(true)

    // still within that interval, but stale: the next kick retries at once
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.autoRefresh()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(registry.snapshot().stale).toBe(false)
  })

  it('shares the in-flight refresh (single-flight): a kick during a fetch adds nothing', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    clock.mockReturnValue(T)
    let release: ((value: Response) => void) | undefined
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve
      }),
    )
    const a = registry.autoRefresh()
    const b = registry.autoRefresh()
    release!(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await Promise.all([a, b])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('serves nothing while signed out', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    sub = null
    fetchMock.mockResolvedValue(jsonResponse(200, { documents: [DOC('doc-1')] }))
    const snapshot = await registry.autoRefresh()
    expect(snapshot.available).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sessionChanged (auth transitions reach the registry immediately)', () => {
  it('sign-out clears the cache and pushes the change — the rows cannot linger', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    expect(registry.snapshot().available).toBe(true)

    const reasons: string[] = []
    registry.onChange((reason) => reasons.push(reason))

    sub = null
    registry.sessionChanged()
    expect(registry.snapshot().available).toBe(false)
    expect(registry.document('doc-1')).toBeUndefined()
    expect(reasons).toEqual(['refreshed'])
  })

  it('an account switch drops the previous owner’s rows and re-lists for the new owner', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    expect(registry.snapshot().documents).toHaveLength(1)

    const reasons: string[] = []
    registry.onChange((reason) => reasons.push(reason))

    sub = 'user-b'
    registry.sessionChanged()
    // B has no cache on this machine: unavailable until B's first sync
    expect(registry.snapshot().available).toBe(false)
    expect(registry.document('doc-1')).toBeUndefined()
    expect(reasons).toEqual(['refreshed'])

    // the section's answer to the push is a list, whose kick fetches B's list
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-b')] }))
    const snapshot = await registry.autoRefresh()
    expect(snapshot.documents.map((d) => d.cloudId)).toEqual(['doc-b'])
  })

  it('emits once per actual change — a repeat call with the same session stays silent', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()

    const reasons: string[] = []
    registry.onChange((reason) => reasons.push(reason))

    sub = null
    registry.sessionChanged()
    registry.sessionChanged() // same session again: nothing new to announce
    expect(reasons).toEqual(['refreshed'])
  })
})

describe('persisted file shape', () => {
  it('stores the owner tag (sub hash), never the sub', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    const stored = JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, unknown>
    expect(stored.owner).toBe(cloudDocsOwner('user-a'))
    expect(JSON.stringify(stored)).not.toContain('user-a')
  })
})

// ── Per-file print policy (Ruling 13) ──────────────────────────────────

describe('print policy (setPrintPolicy)', () => {
  it('maps the server printPolicy through the list (anything unset reads allow)', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        documents: [DOC('doc-deny', { printPolicy: 'deny' }), DOC('doc-allow')],
      }),
    )
    const snapshot = await registry.refresh()
    const byId = new Map(snapshot.documents.map((d) => [d.cloudId, d]))
    expect(byId.get('doc-deny')?.printPolicy).toBe('deny')
    expect(byId.get('doc-allow')?.printPolicy).toBe('allow')
  })

  it('applies optimistically, PUTs the policy, and keeps the cache in step', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { printPolicy: 'deny' }))
    const snapshot = await registry.setPrintPolicy('doc-1', 'deny')

    expect(snapshot.documents[0]?.printPolicy).toBe('deny')
    expect(registry.document('doc-1')?.printPolicy).toBe('deny')
    const put = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(put[0]).toBe('/documents/doc-1/print-policy')
    expect(put[1].method).toBe('PUT')
    expect(put[1].body).toBe(JSON.stringify({ printPolicy: 'deny' }))
    // the policy survives a reload through the persisted cache
    expect(JSON.parse(readFileSync(storePath, 'utf-8'))).toMatchObject({
      documents: [{ cloudId: 'doc-1', printPolicy: 'deny' }],
    })
  })

  it('reverts the optimistic edit and throws when the write fails (never queued)', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()

    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await expect(registry.setPrintPolicy('doc-1', 'deny')).rejects.toThrow('offline')
    // the cache snapped back to server truth: a governance toggle is either
    // delivered or visibly failed, never parked in a queue like a star
    expect(registry.document('doc-1')?.printPolicy).toBe('allow')

    // and a 500 answers the same way
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: { code: 'internal_error' } }))
    await expect(registry.setPrintPolicy('doc-1', 'deny')).rejects.toThrow('HTTP 500')
    expect(registry.document('doc-1')?.printPolicy).toBe('allow')
  })

  it('refuses to address an unknown document or an empty cache', async () => {
    const registry = makeRegistry({
      client: async () => ({ fetch: fetchMock }) as unknown as BackendClient,
    })
    await expect(registry.setPrintPolicy('doc-1', 'deny')).rejects.toThrow(
      'document list is not loaded',
    )
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { documents: [DOC('doc-1')] }))
    await registry.refresh()
    await expect(registry.setPrintPolicy('doc-x', 'deny')).rejects.toThrow('unknown document')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a pre-Ruling-13 cache file without printPolicy loads as allow', () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        owner: cloudDocsOwner('user-a'),
        syncedAt: 1,
        documents: [
          {
            cloudId: 'doc-old',
            name: 'doc-old.md',
            kind: 'md',
            sizeBytes: 1,
            currentVersion: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            starred: false,
            lastOpenedAt: null,
          },
        ],
      }),
    )
    const registry = makeRegistry()
    expect(registry.snapshot().documents[0]?.printPolicy).toBe('allow')
  })
})
