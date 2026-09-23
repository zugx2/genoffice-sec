/**
 * Home → folder panel → Cloud documents section
 * (src/renderer/src/Home.tsx `CloudDocumentsSection`, Phase 7d) — the
 * settings-cloud-account pane-test pattern: the component is rendered into
 * jsdom against a scripted `window.aiOfficeCloud` bridge (exactly the shape
 * the preload exposes) and asserted on its observable behavior:
 *
 * - the section renders the registry's cached list (no rows of its own);
 * - a star click toggles optimistically through the bridge;
 * - the stale badge appears when the registry reports the last-known list;
 * - the pending badge counts star changes still queued main-side;
 * - a row click records the open (the server-side recents stamp), and the
 *   pushed `cloud:documents-changed` event re-lists;
 * - the sign-in hint replaces the rows when nothing is available;
 * - nothing renders at all without the bridge (an older preload).
 */

/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type {
  CloudDocsApi,
  CloudDocumentEntry,
  CloudDocumentsChangedPayload,
  CloudDocumentsSnapshot,
} from '../src/shared/cloud-docs-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { CloudDocumentsSection } from '../src/renderer/src/Home'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.aiOfficeCloud = undefined
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderSection(api: CloudDocsApi): Promise<void> {
  window.aiOfficeCloud = api
  await act(async () => {
    root.render(
      createElement(LocaleProvider, { initial: 'en' }, createElement(CloudDocumentsSection)),
    )
    await Promise.resolve()
  })
  await flush()
}

const DOC = (cloudId: string, over: Partial<CloudDocumentEntry> = {}): CloudDocumentEntry => ({
  cloudId,
  name: `${cloudId}.md`,
  kind: 'md',
  sizeBytes: 12,
  currentVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  starred: false,
  lastOpenedAt: null,
  ...over,
})

/** Controllable CloudDocsApi double: scripted snapshots + captured pushes. */
function makeApi(initial: CloudDocumentsSnapshot) {
  let snapshot = initial
  const listDocuments = vi.fn(async (): Promise<CloudDocumentsSnapshot> => snapshot)
  const toggleStarred = vi.fn(async (): Promise<CloudDocumentsSnapshot> => snapshot)
  const markOpened = vi.fn(async (): Promise<void> => undefined)
  const handlers: Array<(payload: CloudDocumentsChangedPayload) => void> = []
  const api: CloudDocsApi = {
    listDocuments,
    toggleStarred: toggleStarred as unknown as CloudDocsApi['toggleStarred'],
    markOpened,
    onDocumentsChanged: (handler) => {
      handlers.push(handler)
      return () => {}
    },
  }
  return {
    api,
    listDocuments: listDocuments as unknown as Mock,
    toggleStarred: toggleStarred as unknown as Mock,
    markOpened: markOpened as unknown as Mock,
    setSnapshot(next: CloudDocumentsSnapshot): void {
      snapshot = next
    },
    push(payload: CloudDocumentsChangedPayload): void {
      for (const handler of [...handlers]) handler(payload)
    },
  }
}

const AVAILABLE = (documents: CloudDocumentEntry[], over: Partial<CloudDocumentsSnapshot> = {}) =>
  ({
    available: true,
    documents,
    syncedAt: 1_700_000_000_000,
    stale: false,
    pendingStars: 0,
    ...over,
  }) as CloudDocumentsSnapshot

function rowNamed(name: string): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>('.cloud-docs-row')].find((row) =>
    row.textContent?.includes(name),
  )
}

describe('Home → folder panel → Cloud documents section', () => {
  it('renders the registry list with names, icons, and the section count', async () => {
    const h = makeApi(
      AVAILABLE([DOC('doc-a'), DOC('doc-b', { name: 'Budget.xlsx', kind: 'xlsx' })]),
    )
    await renderSection(h.api)

    expect(host.querySelector('.cloud-docs')?.getAttribute('aria-label')).toBe('Cloud documents')
    expect(host.textContent).toContain('doc-a.md')
    expect(host.textContent).toContain('Budget.xlsx')
    expect(host.querySelector('.cloud-docs-count')?.textContent).toBe('2 items')
    // list was read once on mount
    expect(h.listDocuments).toHaveBeenCalledTimes(1)
  })

  it('toggles a star through the bridge and flips the row from the returned snapshot', async () => {
    const h = makeApi(AVAILABLE([DOC('doc-a'), DOC('doc-b')]))
    await renderSection(h.api)

    const starButton = rowNamed('doc-a')?.querySelector('button.star-btn')
    expect(starButton?.getAttribute('aria-label')).toBe('Star')

    // the registry's answer carries the optimistically applied flag
    h.setSnapshot(AVAILABLE([DOC('doc-a', { starred: true }), DOC('doc-b')]))
    await act(async () => {
      starButton?.click()
      await Promise.resolve()
    })
    await flush()

    expect(h.toggleStarred).toHaveBeenCalledWith('doc-a', true)
    expect(rowNamed('doc-a')?.querySelector('button.star-btn')?.className).toContain('starred')
  })

  it('shows the stale badge (and keeps the rows) when the registry is offline', async () => {
    const h = makeApi(AVAILABLE([DOC('doc-a')], { stale: true }))
    await renderSection(h.api)

    expect(host.textContent).toContain('doc-a.md')
    expect(host.querySelector('.cloud-docs-badge.stale')?.textContent).toBe(
      'Offline — showing the last known list',
    )
  })

  it('shows the pending badge when star changes are still queued main-side', async () => {
    const h = makeApi(AVAILABLE([DOC('doc-a')], { pendingStars: 2 }))
    await renderSection(h.api)

    expect(host.querySelector('.cloud-docs-badge.pending')?.textContent).toBe(
      '2 star changes waiting to sync',
    )
  })

  it('records an open on row click and re-lists when the registry pushes a change', async () => {
    const h = makeApi(AVAILABLE([DOC('doc-a'), DOC('doc-b')]))
    await renderSection(h.api)

    await act(async () => {
      rowNamed('doc-a')?.click()
      await Promise.resolve()
    })
    await flush()
    expect(h.markOpened).toHaveBeenCalledWith('doc-a')

    // the pushed change (reason only) makes the section re-read the snapshot
    h.setSnapshot(AVAILABLE([DOC('doc-a', { lastOpenedAt: '2026-03-01T00:00:00.000Z' })]))
    await act(async () => {
      h.push({ reason: 'opened' })
    })
    await flush()
    expect(h.listDocuments).toHaveBeenCalledTimes(2)
  })

  it('orders rows by most recently opened (recents semantics)', async () => {
    const h = makeApi(
      AVAILABLE([
        DOC('older', { createdAt: '2026-01-01T00:00:00.000Z' }),
        DOC('opened-late', {
          createdAt: '2026-01-01T00:00:00.000Z',
          lastOpenedAt: '2026-05-01T00:00:00.000Z',
        }),
      ]),
    )
    await renderSection(h.api)

    const names = [...host.querySelectorAll('.cloud-docs-name')].map((n) => n.textContent)
    expect(names).toEqual(['opened-late.md', 'older.md'])
  })

  it('shows the empty hint when signed in with no documents', async () => {
    const h = makeApi(AVAILABLE([]))
    await renderSection(h.api)
    expect(host.textContent).toContain('No cloud documents yet.')
    expect(host.querySelectorAll('.cloud-docs-row')).toHaveLength(0)
  })

  it('shows the sign-in hint when nothing is available', async () => {
    const h = makeApi({
      available: false,
      documents: [],
      syncedAt: 0,
      stale: false,
      pendingStars: 0,
    })
    await renderSection(h.api)
    expect(host.textContent).toContain('Sign in to your cloud account')
    expect(host.querySelectorAll('.cloud-docs-row')).toHaveLength(0)
  })

  it('clears the rows when the registry turns unavailable (sign-out)', async () => {
    const h = makeApi(AVAILABLE([DOC('doc-a')]))
    await renderSection(h.api)
    expect(host.querySelectorAll('.cloud-docs-row')).toHaveLength(1)

    // the main process answers unavailable once the session ends — the
    // previous account's rows must not linger on screen
    h.setSnapshot({ available: false, documents: [], syncedAt: 0, stale: false, pendingStars: 0 })
    await act(async () => {
      h.push({ reason: 'refreshed' })
    })
    await flush()
    expect(host.querySelectorAll('.cloud-docs-row')).toHaveLength(0)
    expect(host.textContent).toContain('Sign in to your cloud account')
  })

  it('collapses and expands behind the section header', async () => {
    const h = makeApi(AVAILABLE([DOC('doc-a')]))
    await renderSection(h.api)
    const toggle = host.querySelector<HTMLButtonElement>('.cloud-docs-toggle')
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })
    await flush()
    expect(host.querySelectorAll('.cloud-docs-row')).toHaveLength(0)

    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })
    await flush()
    expect(host.querySelectorAll('.cloud-docs-row')).toHaveLength(1)
  })

  it('renders nothing without the bridge (an older preload)', async () => {
    window.aiOfficeCloud = undefined
    await act(async () => {
      root.render(
        createElement(LocaleProvider, { initial: 'en' }, createElement(CloudDocumentsSection)),
      )
      await Promise.resolve()
    })
    await flush()
    expect(host.querySelector('.cloud-docs')).toBeNull()
  })
})
