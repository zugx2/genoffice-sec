import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Ruling 13 export gate + menu wiring (slides): with the shell's cloud gate
 * injected at `setSlidesCloudGate` and a cloud-only deck open in a session,
 * every export of the deck to new local files (page PNGs, PDF export) answers
 * the typed `export-blocked`, printing honors the per-file policy at
 * invocation, a local/hybrid deck (an ordinary path) flows through unchanged,
 * and the File menu disables the export/print items for the active
 * cloud-only tab (the handlers are the enforcement; the menu is the visible
 * half).
 */

type IpcHandler = (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown

interface FakeWebContents {
  id: number
  listeners: Map<string, () => void>
  isDestroyed: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}

// hoisted: slides-main registers some handlers at module import time, before
// the test file's own declarations run
const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
const webContents: FakeWebContents[] = []
const buildFromTemplate = vi.hoisted(() => vi.fn((_template: unknown) => []))
const showOpenDialogWithMemory = vi.hoisted(() => vi.fn())
const showSaveDialogWithMemory = vi.hoisted(() => vi.fn())
let nextWebContentsId = 1

function makeWebContents(): FakeWebContents {
  const listeners = new Map<string, () => void>()
  const contents: FakeWebContents = {
    id: nextWebContentsId++,
    listeners,
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  }
  webContents.push(contents)
  return contents
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
    on: vi.fn(),
    quit: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})),
    getSystemLocale: vi.fn(() => 'en-US'),
    getAppMetrics: vi.fn(() => []),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
    static getFocusedWindow() {
      return null
    }
    isDestroyed = vi.fn(() => true)
    webContents = makeWebContents()
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
  nativeTheme: {},
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  webContents: { getAllWebContents: () => [], fromId: () => null },
  WebContentsView: class {
    webContents = makeWebContents()
  },
}))

vi.mock('@genoffice/electron-utils', () => ({
  configuredDefaultSaveDir: vi.fn(() => tmpdir()),
  contextMenuLabels: vi.fn(() => ({})),
  installContextMenu: vi.fn(),
  installNavigationGuard: vi.fn(),
  isHeadlessMode: vi.fn(() => false),
  rendererUrl: vi.fn(() => 'genoffice-app://slides/index.html'),
  safeExternalUrl: vi.fn(() => null),
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  appMenuLabels: vi.fn(() => ({})),
  toggleDevToolsItem: vi.fn(() => ({})),
  viewMenuTemplate: vi.fn(() => []),
  windowMenuTemplate: vi.fn(() => []),
  helpMenuTemplate: vi.fn(() => []),
}))

vi.mock('../src/main/pdf-export', () => ({ exportSlidesPdf: vi.fn() }))
vi.mock('../src/main/font-store', () => ({
  getPrivateFontData: vi.fn(() => null),
  listPrivateFontFaces: vi.fn(() => []),
  initFontStore: vi.fn(),
}))
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: vi.fn(async () => undefined),
  refineComplexWidths: vi.fn(async () => false),
  initShapedMetrics: vi.fn(),
  complexScriptOf: vi.fn(() => null),
  registerEmbeddedFonts: vi.fn(() => false),
  resetFontMetrics: vi.fn(),
  getFontMetrics: vi.fn(() => ({})),
}))

import {
  buildSlidesMenu,
  registerSlidesIpc,
  setSlidesCloudGate,
  setSlidesDocumentStore,
} from '../src/main/slides-main'
import { sessions, setActiveSlidesWebContents } from '../src/main/session-state'

/** The shell's gate stand-in: paths tagged `cloud-only` are remote-mode,
 * `print-deny` carries a deny policy; messages are marker strings. */
const gate = {
  isCloudOnlyPath: (path: string): boolean => path.includes('cloud-only'),
  printPolicy: (path: string): 'allow' | 'deny' => (path.includes('print-deny') ? 'deny' : 'allow'),
  blockedMessage: (reason: 'export-blocked' | 'print-blocked'): string => `blocked:${reason}`,
}

beforeEach(() => {
  buildFromTemplate.mockClear()
  showOpenDialogWithMemory.mockClear()
  showSaveDialogWithMemory.mockClear()
  setSlidesCloudGate(gate)
  setSlidesDocumentStore({
    forgetOwner: vi.fn(),
  } as unknown as DocumentStore)
  registerSlidesIpc()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  for (const id of [...sessions.keys()]) sessions.delete(id)
  const scratch = join(tmpdir(), 'slides-export-gate-')
  rmSync(scratch, { recursive: true, force: true })
})

/** Pretends a deck is open in this view: the gate reads only `session.path`. */
function openCloudDeck(name: string): FakeWebContents {
  const contents = makeWebContents()
  sessions.set(contents.id, {
    path: join(tmpdir(), 'slides-export-gate-cloud', name),
  } as never)
  return contents
}

function openLocalDeck(name: string): FakeWebContents {
  const contents = makeWebContents()
  sessions.set(contents.id, { path: join(tmpdir(), `local-${name}`) } as never)
  return contents
}

describe('slides export gate (Ruling 13)', () => {
  it('blocks export-images with the typed error before writing any PNG', async () => {
    const contents = openCloudDeck('cloud-only-deck.pptx')

    const result = await handlers.get('slides:export-images')?.(
      { sender: contents },
      {
        dir: tmpdir(),
        baseName: 'deck',
        pngsBase64: ['aGVsbG8='],
      },
    )

    expect(result).toEqual({
      ok: false,
      reason: 'export-blocked',
      error: 'blocked:export-blocked',
    })
  })

  it('blocks export-pdf before the hidden render window', async () => {
    const contents = openCloudDeck('cloud-only-deck.pptx')

    const result = await handlers.get('slides:export-pdf')?.(
      { sender: contents },
      {
        filePath: join(tmpdir(), 'out.pdf'),
        pngsBase64: [],
        widthPx: 960,
        heightPx: 540,
      },
    )

    expect(result).toMatchObject({ ok: false, reason: 'export-blocked' })
  })

  it('blocks print when the per-file policy denies; policy allow proceeds', async () => {
    const denied = openCloudDeck('cloud-only-print-deny.pptx')
    expect(
      await handlers.get('slides:print')?.({ sender: denied }, { pngsBase64: [] }),
    ).toMatchObject({ ok: false, error: 'blocked:print-blocked' })

    // allow (the default): the flow gets past the gate — it then builds its
    // print document and window, which this electron mock does not implement,
    // so "not the typed block" is the assertion
    const allowed = openCloudDeck('cloud-only-print-ok.pptx')
    const result = await handlers.get('slides:print')?.({ sender: allowed }, { pngsBase64: [] })
    expect(result).not.toMatchObject({ reason: 'print-blocked' })
  })

  it('lets a local/hybrid deck export unchanged (untitled decks too)', async () => {
    const local = openLocalDeck('deck.pptx')
    const result = await handlers.get('slides:export-images')?.(
      { sender: local },
      {
        dir: tmpdir(),
        baseName: 'deck',
        pngsBase64: ['aGVsbG8='],
      },
    )
    // past the gate: the write itself hits the (unimplemented) fs of the
    // harness — the assertion is that the block never fired
    expect(result).not.toMatchObject({ reason: 'export-blocked' })
  })

  it('never opens the export destination dialogs for a cloud-only deck (null pick, no dialog)', async () => {
    const contents = openCloudDeck('cloud-only-deck.pptx')

    expect(await handlers.get('slides:pick-export-dir')?.({ sender: contents })).toBeNull()
    expect(
      await handlers.get('slides:pick-export-pdf-path')?.({ sender: contents }, 'deck.pdf'),
    ).toBeNull()
    // the gate answered before either dialog could open
    expect(showOpenDialogWithMemory).not.toHaveBeenCalled()
    expect(showSaveDialogWithMemory).not.toHaveBeenCalled()
  })

  it('opens the destination dialogs for an ordinary local deck', async () => {
    const local = openLocalDeck('deck.pptx')
    showOpenDialogWithMemory.mockResolvedValue({ canceled: true })
    showSaveDialogWithMemory.mockResolvedValue({ canceled: true })

    expect(await handlers.get('slides:pick-export-dir')?.({ sender: local })).toBeNull()
    expect(showOpenDialogWithMemory).toHaveBeenCalled()
    expect(
      await handlers.get('slides:pick-export-pdf-path')?.({ sender: local }, 'deck.pdf'),
    ).toBeNull()
    expect(showSaveDialogWithMemory).toHaveBeenCalled()
  })
})

describe('slides menu wiring (Ruling 13)', () => {
  /** The File menu's export/print items of the built template. */
  const fileItems = (): Array<Record<string, unknown>> => {
    buildSlidesMenu()
    const template = buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
      label?: unknown
      submenu?: Array<Record<string, unknown>>
    }>
    const file =
      template.find((menu) => menu.label === '文件') ?? template.find((menu) => menu.label)
    return ((file?.submenu ?? []) as Array<Record<string, unknown>>).filter(
      (item) =>
        typeof item.click === 'function' &&
        ['export-pdf', 'export-images', 'print'].some((cmd) => String(item.click).includes(cmd)),
    )
  }

  it('disables export and print items while the active tab holds a cloud-only deck', () => {
    const contents = openCloudDeck('cloud-only-print-deny.pptx')
    setActiveSlidesWebContents({ id: contents.id } as never)

    const items = fileItems()
    expect(items).toHaveLength(3)
    for (const item of items) expect(item.enabled, String(item.label)).toBe(false)
  })

  it('keeps export and print enabled for an ordinary local deck', () => {
    const contents = openLocalDeck('deck.pptx')
    setActiveSlidesWebContents({ id: contents.id } as never)

    const items = fileItems()
    expect(items).toHaveLength(3)
    for (const item of items) expect(item.enabled, String(item.label)).toBe(true)
  })
})
