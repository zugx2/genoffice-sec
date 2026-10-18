import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Ruling 13 export gate (markdown): with the shell's cloud gate injected at
 * `setMarkdownCloudGate`, the export flows that write a NEW local file
 * (PDF export, DOCX export dialog mode, save-image-as) block with the typed
 * message before any dialog or byte write, the "open in Docs" hand-off
 * through the app-owned conversion cache stays deliberately ungated, a
 * local/hybrid document flows through unchanged, and the print sender honors
 * the per-file policy (markdown's print is renderer-driven, so the menu
 * sender is the enforcement point; the disabled menu item is the visible
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
  dialog: { showMessageBox },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
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
  rendererUrl: vi.fn(() => 'genoffice-app://markdown/index.html'),
  safeExternalUrl: vi.fn(() => null),
  showOpenDialogWithMemory: vi.fn(),
  showSaveDialogWithMemory,
}))

import {
  createMarkdownView,
  sendMarkdownPrintRequest,
  setMarkdownCloudGate,
  setMarkdownDocumentStore,
} from '../src/main/markdown-main'
import { MARKDOWN_CHANNELS } from '../src/shared/ipc'

/** The shell's gate stand-in: paths tagged `cloud-only` are remote-mode,
 * `print-deny` carries a deny policy; messages are marker strings. */
const gate = {
  isCloudOnlyPath: (path: string): boolean => path.includes('cloud-only'),
  printPolicy: (path: string): 'allow' | 'deny' => (path.includes('print-deny') ? 'deny' : 'allow'),
  blockedMessage: (reason: 'export-blocked' | 'print-blocked'): string => `blocked:${reason}`,
}

function makeStoreMock(): DocumentStore {
  return {
    read: vi.fn(async () => Buffer.from('# doc')),
    write: vi.fn(async () => undefined),
    authorizeWrite: vi.fn(),
    renameOwnerPath: vi.fn(),
    forgetOwner: vi.fn(),
  } as unknown as DocumentStore
}

let directory: string

function openDoc(name: string): { path: string; contents: FakeWebContents } {
  const path = join(directory, name)
  setMarkdownDocumentStore(makeStoreMock())
  const view = createMarkdownView(path)
  return { path, contents: view.webContents as unknown as FakeWebContents }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'markdown-export-gate-'))
  showMessageBox.mockClear()
  showSaveDialogWithMemory.mockReset()
  setMarkdownCloudGate(gate)
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  await rm(directory, { recursive: true, force: true })
})

describe('markdown export gate (Ruling 13)', () => {
  it('blocks the PDF export before its save dialog, with the typed message', async () => {
    const { contents } = openDoc('cloud-only-notes.md')

    const result = await handlers.get(MARKDOWN_CHANNELS.exportPdf)?.(
      { sender: contents },
      { html: '<p>x</p>', suggestedName: 'notes' },
    )

    expect(result).toEqual({ ok: false, error: 'blocked:export-blocked' })
    // surfaced natively (the renderer only logs export failures) and no
    // destination was ever picked
    expect(showMessageBox).toHaveBeenCalled()
    expect(showSaveDialogWithMemory).not.toHaveBeenCalled()
  })

  it('blocks the DOCX export dialog mode; the open-in-Docs cache hand-off stays open', async () => {
    const { contents } = openDoc('cloud-only-notes.md')

    const dialog = await handlers.get(MARKDOWN_CHANNELS.exportDocx)?.(
      { sender: contents },
      { base64: Buffer.from('docx-bytes').toString('base64'), suggestedName: 'notes' },
    )
    expect(dialog).toMatchObject({ ok: false, error: 'blocked:export-blocked' })
    expect(showSaveDialogWithMemory).not.toHaveBeenCalled()

    // an inter-editor hand-off through the app-owned conversion cache is not
    // a user export — deliberately not gated (documented in cloud-storage.md)
    const openInDocs = await handlers.get(MARKDOWN_CHANNELS.exportDocx)?.(
      { sender: contents },
      {
        base64: Buffer.from('docx-bytes').toString('base64'),
        suggestedName: 'notes',
        mode: 'openInDocs',
      },
    )
    expect(openInDocs).toMatchObject({ ok: true })
  })

  it('blocks save-image-as (an embedded image is document content)', async () => {
    const { contents } = openDoc('cloud-only-img.md')

    const result = await handlers.get(MARKDOWN_CHANNELS.saveImageAs)?.(
      {
        sender: contents,
      },
      'asset:pic.png',
    )

    expect(result).toEqual({ ok: false })
    expect(showMessageBox).toHaveBeenCalled()
  })

  it('lets a local/hybrid document export unchanged', async () => {
    openDoc('local-notes.md')
    showSaveDialogWithMemory.mockResolvedValue({ canceled: true })

    const result = await handlers.get(MARKDOWN_CHANNELS.exportPdf)?.(
      { sender: webContents[webContents.length - 1] as never },
      { html: '<p>x</p>', suggestedName: 'notes' },
    )

    // the gate let it through to the (canceled) save dialog: allowed
    expect(result).toEqual({ ok: true, canceled: true })
  })
})

describe('markdown print policy (Ruling 13)', () => {
  it('refuses to forward a print request when the per-file policy denies', () => {
    const { path, contents } = openDoc('cloud-only-print-deny.md')

    sendMarkdownPrintRequest(contents as never)

    expect(contents.send).not.toHaveBeenCalled()
    expect(path).toContain('print-deny') // the fixture drives the deny branch
  })

  it('forwards the print request when the policy allows', () => {
    const { contents } = openDoc('cloud-only-print-ok.md')

    sendMarkdownPrintRequest(contents as never)

    expect(contents.send).toHaveBeenCalledWith(MARKDOWN_CHANNELS.printRequest)
  })
})
