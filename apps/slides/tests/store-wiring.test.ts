import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Document-store wiring (Phase 7f, the docs pilot rolled out to slides): with
 * a mock store injected at the `setSlidesDocumentStore` seam, every deck byte
 * movement goes through it — the routed open read grants the view, a save
 * writes the serialized deck through the store, the MCP silent save records
 * its grant there, recovery offers read the store's recovery contract, a
 * rename re-keys it, and a destroyed view drops its owner.
 */

type IpcHandler = (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown

interface FakeWebContents {
  id: number
  listeners: Map<string, () => void>
  isDestroyed: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}

// hoisted: slides-main registers some handlers at module import time, before
// the test file's own declarations run
const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
const webContents: FakeWebContents[] = []
const showMessageBox = vi.hoisted(() => vi.fn())
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
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => []) },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
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
  showOpenDialogWithMemory: vi.fn(),
  showSaveDialogWithMemory: vi.fn(),
  appMenuLabels: vi.fn(() => ({})),
}))

vi.mock('../src/main/pdf-export', () => ({ exportSlidesPdf: vi.fn() }))
vi.mock('../src/main/font-store', () => ({
  getPrivateFontData: vi.fn(() => null),
  listPrivateFontFaces: vi.fn(() => []),
  initFontStore: vi.fn(),
}))
// the HarfBuzz wasm import cannot resolve under vitest — the shaped-metrics
// fallbacks under test here are the estimator, which is fine for wiring
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
  configureSlidesRuntime,
  createSlidesView,
  discardSlidesRecovery,
  saveSessionDeckTo,
  setSlidesDocumentStore,
} from '../src/main/slides-main'

interface StoreMock {
  exists: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  writeRecovery: ReturnType<typeof vi.fn>
  recoveryStamp: ReturnType<typeof vi.fn>
  readRecovery: ReturnType<typeof vi.fn>
  clearRecovery: ReturnType<typeof vi.fn>
  authorizeWrite: ReturnType<typeof vi.fn>
  renameOwnerPath: ReturnType<typeof vi.fn>
  forgetOwner: ReturnType<typeof vi.fn>
}

function makeStoreMock(): StoreMock {
  return {
    exists: vi.fn(async () => true),
    read: vi.fn(async () => Buffer.from('deck bytes')),
    write: vi.fn(async () => undefined),
    writeRecovery: vi.fn(async () => undefined),
    recoveryStamp: vi.fn(() => null),
    readRecovery: vi.fn(async () => null),
    clearRecovery: vi.fn(),
    authorizeWrite: vi.fn(),
    renameOwnerPath: vi.fn(),
    forgetOwner: vi.fn(),
  }
}

function asStore(mock: StoreMock): DocumentStore {
  return mock as unknown as DocumentStore
}

let temporaryDirectories: string[] = []

beforeEach(() => {
  temporaryDirectories = []
  showMessageBox.mockReset()
  configureSlidesRuntime({ preloadPath: 'preload.js', rendererDevUrl: 'genoffice-app://slides' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function writeDeckFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'slides-store-wiring-'))
  temporaryDirectories.push(directory)
  const deckPath = join(directory, 'deck.pptx')
  await writeFile(deckPath, await createBlankPptx())
  return deckPath
}

describe('slides document-store wiring', () => {
  it('routes the open read through the store and grants the view', async () => {
    const deckPath = await writeDeckFile()
    const store = makeStoreMock()
    const bytes = await createBlankPptx()
    store.read.mockImplementation(async () => Buffer.from(bytes))
    setSlidesDocumentStore(asStore(store))
    const view = createSlidesView(deckPath)
    const contents = view.webContents as unknown as FakeWebContents

    // the queued open is consumed by the renderer after mount
    const result = await handlers.get('slides:consume-pending-open')?.({ sender: contents }, 1280)

    expect(result).toMatchObject({ path: deckPath })
    expect(store.read).toHaveBeenCalledWith({ path: deckPath })
    expect(store.authorizeWrite).toHaveBeenCalledWith(contents.id, { path: deckPath })
  })

  it('routes a save through the store', async () => {
    const deckPath = await writeDeckFile()
    const store = makeStoreMock()
    const bytes = await createBlankPptx()
    store.read.mockImplementation(async () => Buffer.from(bytes))
    setSlidesDocumentStore(asStore(store))
    const view = createSlidesView(deckPath)
    const contents = view.webContents as unknown as FakeWebContents
    await handlers.get('slides:consume-pending-open')?.({ sender: contents }, 1280)

    const result = await handlers.get('slides:save')?.({ sender: contents })

    expect(result).toMatchObject({ ok: true, path: deckPath })
    expect(store.write).toHaveBeenCalledTimes(1)
    const [ref, written] = store.write.mock.calls[0] as [{ path: string }, Buffer]
    expect(ref.path).toBe(deckPath)
    // the written bytes are a real pptx the store could hand back
    expect(written.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('routes the MCP silent save through the store', async () => {
    const deckPath = await writeDeckFile()
    const store = makeStoreMock()
    setSlidesDocumentStore(asStore(store))
    const target = join(deckPath, '..', 'mcp-deck.pptx')

    // a synthetic session (the module's own sessions map is not exported):
    // the save side effects under test are the routed store write
    const { openPptx } = await import('@genoffice/pptx-engine')
    const session = {
      path: '',
      opened: await openPptx(await createBlankPptx()),
      fitWidthPx: 1280,
      undoStack: [],
      redoStack: [],
    } as never as Parameters<typeof saveSessionDeckTo>[0]

    await expect(saveSessionDeckTo(session, target)).resolves.toBeUndefined()

    expect(session.path).toBe(target)
    expect(store.write).toHaveBeenCalledTimes(1)
    const [ref, written] = store.write.mock.calls[0] as [{ path: string }, Buffer]
    expect(ref.path).toBe(target)
    expect(written.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('offers recovery through the store and clears it on discard', async () => {
    const deckPath = await writeDeckFile()
    const store = makeStoreMock()
    const bytes = await createBlankPptx()
    store.read.mockImplementation(async () => Buffer.from(bytes))
    // a recovery copy strictly newer than the deck: the open must restore it
    store.recoveryStamp.mockReturnValue({
      recoveryMtimeMs: 10_000,
      documentMtimeMs: 5_000,
    })
    store.readRecovery.mockImplementation(async () => Buffer.from(bytes))
    setSlidesDocumentStore(asStore(store))
    const view = createSlidesView(deckPath)
    const contents = view.webContents as unknown as FakeWebContents
    // the Restore/Discard prompt fires during the open: Restore keeps the copy
    showMessageBox.mockResolvedValue({ response: 0 })
    await handlers.get('slides:consume-pending-open')?.({ sender: contents }, 1280)

    // Don't Save discards the stored copy
    showMessageBox.mockResolvedValue({ response: 1 })
    const { requestSlidesClose } = await import('../src/main/slides-main')
    await expect(requestSlidesClose(contents as never)).resolves.toBe(true)
    expect(store.clearRecovery).toHaveBeenCalledWith({ path: deckPath })
    expect(store.readRecovery).toHaveBeenCalledWith({ path: deckPath })
  })

  it('re-keys the store on a rename and drops the owner when the view dies', async () => {
    const deckPath = await writeDeckFile()
    const store = makeStoreMock()
    const bytes = await createBlankPptx()
    store.read.mockImplementation(async () => Buffer.from(bytes))
    setSlidesDocumentStore(asStore(store))
    const view = createSlidesView(deckPath)
    const contents = view.webContents as unknown as FakeWebContents
    await handlers.get('slides:consume-pending-open')?.({ sender: contents }, 1280)

    const slidesMain = await import('../src/main/slides-main')
    const newPath = join(deckPath, '..', 'renamed.pptx')
    slidesMain.slidesFileRenamed(contents as never, deckPath, newPath)
    expect(store.renameOwnerPath).toHaveBeenCalledWith(contents.id, deckPath, newPath)

    contents.listeners.get('destroyed')?.()
    expect(store.forgetOwner).toHaveBeenCalledWith(contents.id)
  })

  it('clears the stored recovery copy on the MCP discard path', async () => {
    const deckPath = await writeDeckFile()
    const store = makeStoreMock()
    const bytes = await createBlankPptx()
    store.read.mockImplementation(async () => Buffer.from(bytes))
    setSlidesDocumentStore(asStore(store))
    const view = createSlidesView(deckPath)
    const contents = view.webContents as unknown as FakeWebContents
    await handlers.get('slides:consume-pending-open')?.({ sender: contents }, 1280)

    discardSlidesRecovery(contents as never)
    expect(store.clearRecovery).toHaveBeenCalledWith({ path: deckPath })
  })
})
