import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDocumentStore } from '@genoffice/document-store'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Document-store wiring (Phase 7f, the docs pilot rolled out to sheets): the
 * `setSheetsDocumentStore` seam is what every workbook byte movement routes
 * through — the session snapshot at open, the save, the recovery copies, the
 * csv import source, and the MCP write grants. The sidecar-dependent byte
 * flows need the native binary, so this suite pins the seams that are
 * reachable without it: the injected store receives the MCP save grant
 * (`authorizeMcpSheetWrite` — the guard-parity shape) and drops a view's
 * owner when its webContents dies.
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

const handlers = new Map<string, IpcHandler>()
const webContents: FakeWebContents[] = []
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
    isPackaged: true,
    getSystemLocale: vi.fn(() => 'en-US'),
    commandLine: { appendSwitch: vi.fn() },
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
    static getFocusedWindow() {
      return null
    }
    static getAllWindows() {
      return []
    }
    isDestroyed = vi.fn(() => true)
    webContents = makeWebContents()
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => []) },
  desktopCapturer: { getSources: vi.fn(async () => []) },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
  net: { fetch: vi.fn() },
  screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 800, height: 600 } })) },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn() } },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  systemPreferences: { getSystemColor: vi.fn(() => '#000000') },
  WebContentsView: class {
    webContents = makeWebContents()
  },
}))

vi.mock('@genoffice/electron-utils', () => ({
  appMenuLabels: vi.fn(() => ({})),
  buildPrintableHtml: vi.fn(async () => ''),
  configuredDefaultSaveDir: vi.fn(() => tmpdir()),
  contextMenuLabels: vi.fn(() => ({})),
  fetchRemoteImage: vi.fn(),
  helpMenuTemplate: vi.fn(() => []),
  installContextMenu: vi.fn(),
  installNavigationGuard: vi.fn(),
  installRendererProtocol: vi.fn(),
  printHtmlToPdf: vi.fn(async () => Buffer.alloc(0)),
  registerRendererScheme: vi.fn(),
  rendererUrl: vi.fn(() => 'genoffice-app://sheets/index.html'),
  safeExternalUrl: vi.fn(() => null),
  showOpenDialogWithMemory: vi.fn(),
  showSaveDialogWithMemory: vi.fn(),
  viewMenuTemplate: vi.fn(() => []),
  windowMenuTemplate: vi.fn(() => []),
}))

import {
  authorizeMcpSheetWrite,
  configureSheetsRuntime,
  createSheetsView,
  setSheetsDocumentStore,
} from '../src/main/sheets-main'

interface StoreMock {
  authorizeWrite: ReturnType<typeof vi.fn>
  forgetOwner: ReturnType<typeof vi.fn>
  renameOwnerPath: ReturnType<typeof vi.fn>
}

function makeStoreMock(): StoreMock {
  return {
    authorizeWrite: vi.fn(),
    forgetOwner: vi.fn(),
    renameOwnerPath: vi.fn(),
  }
}

function asStore(mock: StoreMock): DocumentStore {
  return mock as unknown as DocumentStore
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
})

describe('sheets document-store wiring', () => {
  it('drops a view’s store owner when its webContents is destroyed', () => {
    const store = makeStoreMock()
    setSheetsDocumentStore(asStore(store))
    configureSheetsRuntime({
      preloadPath: 'preload.js',
      rendererFile: 'index.html',
      // the sidecar binary is absent in tests: start() warns and the view
      // still registers (its store bookkeeping is what is under test here)
      sidecarPath: join(tmpdir(), 'no-such-xlsx-sidecar'),
    })

    const view = createSheetsView({ includeAiHandlers: false })
    const contents = view.webContents as unknown as FakeWebContents

    contents.listeners.get('destroyed')?.()
    expect(store.forgetOwner).toHaveBeenCalledWith(contents.id)
  })

  it('records the MCP silent-save grant through the store', () => {
    const store = makeStoreMock()
    setSheetsDocumentStore(asStore(store))

    const target = join(tmpdir(), 'mcp-target.xlsx')
    authorizeMcpSheetWrite(42, target)

    expect(store.authorizeWrite).toHaveBeenCalledWith(42, { path: target })
  })

  it('accepts the full DocumentStore contract at the seam', () => {
    // standalone sheets' default store is exactly this adapter; installing it
    // (or the shell's router) must need nothing beyond the interface
    expect(() => setSheetsDocumentStore(new LocalDocumentStore(tmpdir()))).not.toThrow()
  })
})
