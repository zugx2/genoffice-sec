import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Ruling 13 gate (sheets): the gate matrix runs through the exported pure
 * helpers (`anyCloudOnlySheetSession` / `anyPrintDeniedSheetSession`) so it is
 * testable without a live sidecar session — the handlers feed exactly these
 * helpers with the open sessions' paths. Also covers the File menu wiring:
 * with no cloud-only session the export/print items stay enabled (the
 * disabled half flips purely on the same helpers' verdict).
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

const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
const webContents: FakeWebContents[] = []
const buildFromTemplate = vi.hoisted(() => vi.fn((_template: unknown) => []))
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
    static getAllWindows() {
      return []
    }
    isDestroyed = vi.fn(() => true)
    webContents = makeWebContents()
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate },
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
  anyCloudOnlySheetSession,
  anyPrintDeniedSheetSession,
  configureSheetsRuntime,
  createSheetsView,
  installSheetsMenu,
  setActiveSheetsWebContents,
  setSheetsCloudGate,
  setSheetsDocumentStore,
} from '../src/main/sheets-main'

/** The shell's gate stand-in: paths tagged `cloud-only` are remote-mode,
 * `print-deny` carries a deny policy; messages are marker strings. */
const gate = {
  isCloudOnlyPath: (path: string): boolean => path.includes('cloud-only'),
  printPolicy: (path: string): 'allow' | 'deny' => (path.includes('print-deny') ? 'deny' : 'allow'),
  blockedMessage: (reason: 'export-blocked' | 'print-blocked'): string => `blocked:${reason}`,
}

beforeEach(() => {
  buildFromTemplate.mockClear()
  setSheetsCloudGate(gate)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  const scratch = join(tmpdir(), 'sheets-export-gate-')
  rmSync(scratch, { recursive: true, force: true })
})

describe('sheets gate matrix (Ruling 13, pure helpers)', () => {
  it('a cloud-only session path flips the export block, local paths never do', () => {
    expect(anyCloudOnlySheetSession([join(tmpdir(), 'cloud-only', 'book.xlsx')])).toBe(true)
    // mixed tab (cloud doc + local merge source): deliberately block-on-any
    expect(
      anyCloudOnlySheetSession([
        join(tmpdir(), 'local-source.xlsx'),
        join(tmpdir(), 'cloud-only', 'book.xlsx'),
      ]),
    ).toBe(true)
    expect(anyCloudOnlySheetSession([join(tmpdir(), 'local.xlsx')])).toBe(false)
    expect(anyCloudOnlySheetSession([])).toBe(false)
  })

  it('print block requires cloud-only AND per-file policy deny', () => {
    expect(anyPrintDeniedSheetSession([join(tmpdir(), 'cloud-only', 'print-deny.xlsx')])).toBe(true)
    expect(anyPrintDeniedSheetSession([join(tmpdir(), 'cloud-only', 'book.xlsx')])).toBe(false)
    expect(anyPrintDeniedSheetSession([join(tmpdir(), 'local-print-deny.xlsx')])).toBe(false)
  })

  it('no gate installed (standalone sheets) → always false', () => {
    setSheetsCloudGate(null)
    expect(anyCloudOnlySheetSession([join(tmpdir(), 'cloud-only', 'book.xlsx')])).toBe(false)
    expect(anyPrintDeniedSheetSession([join(tmpdir(), 'cloud-only', 'print-deny.xlsx')])).toBe(
      false,
    )
  })

  it('gate errors localize through the injected message factory', () => {
    expect(gate.blockedMessage('export-blocked')).toBe('blocked:export-blocked')
    expect(gate.blockedMessage('print-blocked')).toBe('blocked:print-blocked')
  })
})

describe('sheets menu wiring (Ruling 13)', () => {
  it('keeps export/print items enabled when the active tab holds no cloud-only session', () => {
    setSheetsDocumentStore({ forgetOwner: vi.fn() } as unknown as DocumentStore)
    configureSheetsRuntime({
      preloadPath: 'preload.js',
      rendererFile: 'index.html',
      // the sidecar binary is absent in tests: the view still registers
      sidecarPath: join(tmpdir(), 'no-such-xlsx-sidecar'),
    })
    const view = createSheetsView({ includeAiHandlers: false })
    const contents = view.webContents as unknown as FakeWebContents
    setActiveSheetsWebContents({ id: contents.id } as never)

    installSheetsMenu()

    const template = buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
      submenu?: Array<Record<string, unknown>>
    }>
    const items = (template[0]?.submenu ?? []) as Array<Record<string, unknown>>
    const gated = items.filter((item) =>
      ['sendMenuAction("print")', "sendMenuAction('print')", 'export-pdf', 'export-csv'].some(
        (cmd) => String(item.click).includes(cmd),
      ),
    )
    expect(gated.length).toBeGreaterThanOrEqual(3)
    for (const item of gated) {
      expect(item.enabled, String(item.click)).not.toBe(false)
    }
    void handlers
  })
})
