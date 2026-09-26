/**
 * @vitest-environment jsdom
 *
 * The Settings → Account → storage section (SettingsModal's
 * `StorageModeSection`) against a scripted preload bridge
 * (`window.aiOfficeStorage`), in the settings-cloud-account.test.ts style —
 * the component is exercised through the DOM, the bridge mock asserts the
 * calls. Covered: the section renders the current mode; a signed-out picker
 * of remote/hybrid is refused before any invoke (the local pre-guard; the
 * main-side guard's own half is pinned by storage-mode.test.ts); and the
 * migration dialog's offer → running → done machine with its retry path and
 * its typed-refusal exit.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { HomeApi } from '../src/shared/home-api'
import type {
  MigrationProgressPayload,
  MigrateDocumentsResult,
  SetStorageModeResult,
  StorageMode,
  StorageModeState,
} from '../src/shared/storage-mode-api'
import type { StorageModeApi } from '../src/shared/storage-mode-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal, type SettingsModalProps } from '../src/renderer/src/SettingsModal'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  window.aiOffice = {
    getTheme: async () => 'system',
    getDefaultSaveDir: async () => '',
    getAnalyticsEnabled: async () => true,
    getAutoSaveDefault: async () => ({ on: false, updatedAt: 0 }),
    getAiPanelPrefs: async () => ({ fontSize: 'default', spellcheck: true }),
    getUpdateChannel: async () => 'stable',
    getAppVersion: async () => '1.0.0',
    githubStars: async () => null,
  } as unknown as HomeApi
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.aiOfficeStorage = undefined
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLButtonElement).click()
    await Promise.resolve()
  })
  await flush()
}

function buttonWithText(text: string, scope: ParentNode = host): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
}

const radios = (): HTMLButtonElement[] =>
  [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[]

/** a mode radio (its textContent also carries the description line) */
const radioWithLabel = (label: string): HTMLButtonElement | undefined =>
  radios().find((r) => r.textContent?.includes(label))

// ── the storage bridge double ─────────────────────────────────────────────

interface StorageHarness {
  api: StorageModeApi
  getStorageMode: Mock
  setStorageMode: Mock
  migrateDocuments: Mock
  /** the persisted mode (only a GUARDED set call may change it) */
  persisted: StorageMode
  emitModeChanged: (state: StorageModeState) => void
  emitProgress: (payload: MigrationProgressPayload) => void
  /** resolve the pending migrateDocuments invoke */
  resolveMigrate: (result: MigrateDocumentsResult) => void
  /** how many documents a local → cloud switch would offer to move */
  localCount: number
}

function makeStorage(initial: StorageModeState): StorageHarness {
  let state = initial
  const changeHandlers: Array<(s: StorageModeState) => void> = []
  const progressHandlers: Array<(p: MigrationProgressPayload) => void> = []
  let migrateResolver: ((result: MigrateDocumentsResult) => void) | undefined
  const harness: StorageHarness = {
    getStorageMode: undefined as unknown as Mock,
    setStorageMode: undefined as unknown as Mock,
    migrateDocuments: undefined as unknown as Mock,
    persisted: initial.mode,
    emitModeChanged: (next) => {
      state = next
      for (const handler of [...changeHandlers]) handler(next)
    },
    emitProgress: (payload) => {
      for (const handler of [...progressHandlers]) handler(payload)
    },
    resolveMigrate: (result) => {
      migrateResolver?.(result)
    },
    localCount: 0,
  }
  const api: StorageModeApi = {
    getStorageMode: vi.fn(async (): Promise<StorageModeState> => state),
    // mirrors the main-side shape: a switch returns the offer a migration
    // would have (upload after local → cloud, download after remote → local)
    setStorageMode: vi.fn(async (mode: StorageMode): Promise<SetStorageModeResult> => {
      const previous = state.mode
      harness.persisted = mode
      state = { ...state, mode }
      if (previous === 'local' && mode !== 'local') {
        return { ok: true, mode, migration: { direction: 'upload', count: harness.localCount } }
      }
      if (previous === 'remote' && mode !== 'remote') {
        return { ok: true, mode, migration: { direction: 'download', count: 0 } }
      }
      return { ok: true, mode }
    }),
    openDocument: vi.fn(),
    migrateDocuments: vi.fn(
      (direction: 'upload' | 'download', retry?: string[]): Promise<MigrateDocumentsResult> =>
        new Promise<MigrateDocumentsResult>((resolve) => {
          migrateResolver = resolve
          void direction
          void retry
        }),
    ),
    onStorageModeChanged: (handler) => {
      changeHandlers.push(handler)
      return () => {}
    },
    onMigrationProgress: (handler) => {
      progressHandlers.push(handler)
      return () => {}
    },
  }
  harness.getStorageMode = api.getStorageMode as unknown as Mock
  harness.setStorageMode = api.setStorageMode as unknown as Mock
  harness.migrateDocuments = api.migrateDocuments as unknown as Mock
  window.aiOfficeStorage = api
  return harness
}

async function renderModal(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(SettingsModal, {
          status: null,
          loggingOut: false,
          loginWaiting: false,
          loginUrl: null,
          urlCopied: false,
          onOpenLoginUrl: vi.fn(),
          onCopyLoginUrl: vi.fn(),
          onClose: vi.fn(),
          onLogin: vi.fn(),
          onLogout: vi.fn(),
        } satisfies SettingsModalProps),
      ),
    )
    await Promise.resolve()
  })
  await flush()
}

// ── the tests ─────────────────────────────────────────────────────────────

describe('Settings → Account → document storage', () => {
  it('renders the section with the current mode selected', async () => {
    makeStorage({ mode: 'hybrid', signedIn: true })
    await renderModal()

    expect(host.querySelector('.set-storage')).toBeTruthy()
    expect(host.textContent).toContain('Document storage')
    expect(host.textContent).toContain('Local + cloud')
    const checked = radios().map((r) => r.getAttribute('aria-checked'))
    expect(checked).toEqual(['false', 'false', 'true'])
    expect(radios()[2]!.className).toContain('active')
  })

  it('renders nothing without the storage bridge', async () => {
    window.aiOfficeStorage = undefined
    await renderModal()
    expect(host.querySelector('.set-storage')).toBeNull()
  })

  it('a signed-out picker of a cloud mode shows the guard and never invokes the set', async () => {
    const h = makeStorage({ mode: 'local', signedIn: false })
    await renderModal()

    await click(radioWithLabel('Cloud only'))
    // the guard error, and the mode untouched
    expect(host.textContent).toContain('Sign in to your cloud account to use this storage mode.')
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(h.persisted).toBe('local')
    // the local pre-guard answered without a round-trip
    expect(h.setStorageMode).not.toHaveBeenCalled()

    // local itself stays selectable while signed out
    expect(radios()[0]!.disabled).toBe(false)
  })

  it('runs the migration dialog offer → running → done, and retries only the failures', async () => {
    const h = makeStorage({ mode: 'local', signedIn: true })
    h.localCount = 2
    await renderModal()

    // the switch returns the offer; the dialog shows it opt-in
    await click(radioWithLabel('Cloud only'))
    expect(h.setStorageMode).toHaveBeenCalledWith('remote')
    expect(host.textContent).toContain(
      'Upload 2 documents from your documents folder to the cloud?',
    )
    expect(buttonWithText('Start moving')).toBeTruthy()
    expect(buttonWithText('Not now')).toBeTruthy()

    // opt in: the move runs, totals come from the progress pushes
    await click(buttonWithText('Start moving'))
    expect(h.migrateDocuments).toHaveBeenCalledTimes(1)
    expect(h.migrateDocuments).toHaveBeenCalledWith('upload', undefined)
    expect(host.textContent).toContain('Moving documents… 0/0')
    // the selector is locked while the move runs
    expect(radios().every((r) => r.disabled)).toBe(true)

    await act(async () => {
      h.emitProgress({ done: 1, total: 2, current: 'a.docx', failures: [] })
    })
    await flush()
    expect(host.textContent).toContain('Moving documents… 1/2')

    // the run ends: one moved, one failure listed by name with its code
    await act(async () => {
      h.resolveMigrate({
        ok: true,
        moved: 1,
        failures: [{ name: 'b.docx', error: 'unavailable', source: '/docs/b.docx' }],
      })
    })
    await flush()
    expect(host.textContent).toContain('1 documents moved.')
    expect(host.textContent).toContain('1 failed.')
    expect(host.textContent).toContain('b.docx')
    expect(host.textContent).toContain('Could not reach the cloud')
    expect(radios().every((r) => r.disabled)).toBe(false)

    // retry: exactly the failed steps' sources, and the totals reset
    await click(buttonWithText('Retry failed'))
    expect(h.migrateDocuments).toHaveBeenCalledTimes(2)
    expect(h.migrateDocuments).toHaveBeenLastCalledWith('upload', ['/docs/b.docx'])
    expect(host.textContent).toContain('Moving documents… 0/0')

    await act(async () => {
      h.resolveMigrate({ ok: true, moved: 1, failures: [] })
    })
    await flush()
    expect(host.textContent).toContain('1 documents moved.')
    expect(host.textContent).not.toContain('1 failed.')
    expect(buttonWithText('Retry failed')).toBeUndefined()
  })

  it('a typed migration refusal ends the run instead of leaving it stuck on running', async () => {
    const h = makeStorage({ mode: 'local', signedIn: true })
    h.localCount = 1
    await renderModal()

    await click(radioWithLabel('Cloud only'))
    await click(buttonWithText('Start moving'))
    expect(host.textContent).toContain('Moving documents…')

    // the mode moved under the open dialog: the main side answers
    // `no-such-migration`, and the machine leaves `running`
    await act(async () => {
      h.resolveMigrate({ ok: false, error: 'no-such-migration' })
    })
    await flush()
    expect(host.textContent).not.toContain('Moving documents…')
    expect(radios().every((r) => r.disabled)).toBe(false)
  })
})
