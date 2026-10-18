import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Ruling 13 export gate (html): with the shell's cloud gate injected at
 * `setHtmlCloudGate`, the three export flows that write a NEW local file
 * (docx / pdf / single-file html) block with the typed message before any
 * dialog opens, the print sender honors the per-file policy as a backstop,
 * and a local/hybrid document flows through unchanged. Active document =
 * `savePathByWc`, already tracked for saves.
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

const handlers = new Map<string, IpcHandler>()
const webContents: FakeWebContents[] = []
const showMessageBox = vi.hoisted(() => vi.fn(async () => ({ response: 0 })))
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
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
    static getFocusedWindow() {
      return null
    }
  },
  dialog: { showMessageBox, showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  webContents: { getAllWebContents: () => [] },
  WebContentsView: class {
    webContents = makeWebContents()
  },
}))

vi.mock('@genoffice/electron-utils', () => ({
  configuredDefaultSaveDir: vi.fn(() => tmpdir()),
  contextMenuLabels: vi.fn(() => ({})),
  fetchRemoteImage: vi.fn(),
  installContextMenu: vi.fn(),
  installNavigationGuard: vi.fn(),
  isHeadlessMode: vi.fn(() => false),
  rendererUrl: vi.fn(() => 'genoffice-app://html/index.html'),
  safeExternalUrl: vi.fn(() => null),
  showOpenDialogWithMemory: vi.fn(),
  showSaveDialogWithMemory,
  installRendererProtocol: vi.fn(),
  registerRendererScheme: vi.fn(),
}))

import {
  createHtmlView,
  sendHtmlPrintRequest,
  setHtmlCloudGate,
  setHtmlDocumentStore,
} from '../src/main/html-main'
import { HTML_CHANNELS } from '../src/shared/ipc'

/** The shell's gate stand-in: paths tagged `cloud-only` are remote-mode,
 * `print-deny` carries a deny policy; messages are marker strings. */
const gate = {
  isCloudOnlyPath: (path: string): boolean => path.includes('cloud-only'),
  printPolicy: (path: string): 'allow' | 'deny' => (path.includes('print-deny') ? 'deny' : 'allow'),
  blockedMessage: (reason: 'export-blocked' | 'print-blocked'): string => `blocked:${reason}`,
}

function makeStoreMock(): DocumentStore {
  return {
    read: vi.fn(async () => Buffer.from('<p>doc</p>')),
    write: vi.fn(async () => undefined),
    authorizeWrite: vi.fn(),
    renameOwnerPath: vi.fn(),
    forgetOwner: vi.fn(),
  } as unknown as DocumentStore
}

let directory: string

function openDoc(name: string): { path: string; contents: FakeWebContents } {
  const path = join(directory, name)
  setHtmlDocumentStore(makeStoreMock())
  const view = createHtmlView(path)
  return { path, contents: view.webContents as unknown as FakeWebContents }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'html-export-gate-'))
  showMessageBox.mockClear()
  showSaveDialogWithMemory.mockReset()
  setHtmlCloudGate(gate)
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  await rm(directory, { recursive: true, force: true })
})

describe('html export gate (Ruling 13)', () => {
  it('blocks all three export formats before their save dialog, with the typed message', async () => {
    const { contents } = openDoc('cloud-only-page.html')

    for (const channel of [
      HTML_CHANNELS.exportDocx,
      HTML_CHANNELS.exportPdf,
      HTML_CHANNELS.exportHtml,
    ]) {
      const result = await handlers.get(channel)?.(
        { sender: contents },
        { html: '<p>x</p>', suggestedName: 'page' },
      )
      expect(result, channel).toEqual({ ok: false, error: 'blocked:export-blocked' })
    }
    // surfaced natively (the renderer shows only a generic notice) and no
    // destination was ever picked
    expect(showMessageBox).toHaveBeenCalledTimes(3)
    expect(showSaveDialogWithMemory).not.toHaveBeenCalled()
  })

  it('lets a local/hybrid document export unchanged (gate passes to the dialog)', async () => {
    openDoc('local-page.html')
    showSaveDialogWithMemory.mockResolvedValue({ canceled: true })
    const contents = webContents[webContents.length - 1] as never

    const result = await handlers.get(HTML_CHANNELS.exportPdf)?.(
      { sender: contents },
      { html: '<p>x</p>', suggestedName: 'page' },
    )

    expect(result).toEqual({ ok: true, canceled: true })
  })

  it('no gate installed (standalone html) → nothing is ever blocked', async () => {
    setHtmlCloudGate(null)
    const { contents } = openDoc('cloud-only-standalone.html')
    showSaveDialogWithMemory.mockResolvedValue({ canceled: true })

    const result = await handlers.get(HTML_CHANNELS.exportPdf)?.(
      { sender: contents },
      { html: '<p>x</p>', suggestedName: 'page' },
    )

    expect(result).toEqual({ ok: true, canceled: true })
  })
})

describe('html print policy (Ruling 13 backstop)', () => {
  it('refuses to forward a print request when the per-file policy denies', () => {
    const { contents } = openDoc('cloud-only-print-deny.html')

    sendHtmlPrintRequest(contents as never)

    expect(contents.send).not.toHaveBeenCalled()
  })

  it('forwards the print request when the policy allows', () => {
    const { contents } = openDoc('cloud-only-print-ok.html')

    sendHtmlPrintRequest(contents as never)

    expect(contents.send).toHaveBeenCalledWith(HTML_CHANNELS.printRequest)
  })
})
