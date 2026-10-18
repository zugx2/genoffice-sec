import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Ruling 13 export gate (apps/pdf/src/main/pdf-main.ts): with the shell's
 * cloud gate injected at `setPdfCloudGate`, every flow that writes the open
 * document's derived bytes to a NEW local file answers the typed
 * `export-blocked` before any dialog opens and before a single byte leaves —
 * extract/split/merge/merge-pages (new PDFs) and export-images (page PNGs) —
 * while a local/hybrid document flows through unchanged, and printing honors
 * the per-file print policy at invocation time (`pdf:print-gate`).
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
const showOpenDialog = vi.hoisted(() => vi.fn())
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
  dialog: { showMessageBox: vi.fn(), showOpenDialog, showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  WebContentsView: class {
    webContents = makeWebContents()
  },
}))

vi.mock('@genoffice/electron-utils', () => ({
  buildPrintableHtml: vi.fn(async () => ''),
  configuredDefaultSaveDir: vi.fn(() => tmpdir()),
  contextMenuLabels: vi.fn(() => ({})),
  installContextMenu: vi.fn(),
  installNavigationGuard: vi.fn(),
  printHtmlToPdf: vi.fn(async () => Buffer.alloc(0)),
  safeExternalUrl: vi.fn(() => null),
  showOpenDialogWithMemory: showOpenDialog,
  showSaveDialogWithMemory: vi.fn(),
  installRendererProtocol: vi.fn(),
  registerRendererScheme: vi.fn(),
  rendererUrl: vi.fn(() => 'genoffice-app://pdf/index.html'),
}))

import { createPdfView, setPdfCloudGate, setPdfDocumentStore } from '../src/main/pdf-main'
import { blankPdfBuffer } from '../src/main/blank-pdf'
import { PDF_CHANNELS } from '../src/shared/ipc'

/** The shell's gate stand-in: paths tagged `cloud-only` are remote-mode, paths
 * tagged `print-deny` carry a deny policy; messages are marker strings. */
const gate = {
  isCloudOnlyPath: (path: string): boolean => path.includes('cloud-only'),
  printPolicy: (path: string): 'allow' | 'deny' => (path.includes('print-deny') ? 'deny' : 'allow'),
  blockedMessage: (reason: 'export-blocked' | 'print-blocked'): string => `blocked:${reason}`,
}

function makeStoreMock(readResult: Buffer): DocumentStore {
  return {
    read: vi.fn(async () => readResult),
    write: vi.fn(async () => undefined),
    authorizeWrite: vi.fn(),
    renameOwnerPath: vi.fn(),
    forgetOwner: vi.fn(),
  } as unknown as DocumentStore
}

let directory: string

async function openDoc(name: string): Promise<{ path: string; contents: FakeWebContents }> {
  const pdfPath = join(directory, name)
  const store = makeStoreMock(await blankPdfBuffer())
  setPdfDocumentStore(store)
  const view = createPdfView(pdfPath)
  return { path: pdfPath, contents: view.webContents as unknown as FakeWebContents }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pdf-export-gate-'))
  showOpenDialog.mockReset()
  setPdfCloudGate(gate)
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  await rm(directory, { recursive: true, force: true })
})

describe('pdf export gate (Ruling 13)', () => {
  it('blocks extract-pages with the typed error before any byte leaves', async () => {
    const { path, contents } = await openDoc('cloud-only-doc.pdf')

    const result = await handlers.get(PDF_CHANNELS.extractPages)?.(
      { sender: contents },
      { path, pages: [0], suggestedName: 'pages.pdf' },
    )

    expect(result).toEqual({
      ok: false,
      reason: 'export-blocked',
      error: 'blocked:export-blocked',
    })
    // blocked at the gate: no dialog, no conversion, no output file
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('blocks split (before the folder dialog), merge and merge-pages', async () => {
    const { path, contents } = await openDoc('cloud-only-merge-me.pdf')

    const split = await handlers.get(PDF_CHANNELS.splitPdf)?.(
      { sender: contents },
      { path, chunkSize: 1, baseName: 'part' },
    )
    expect(split).toMatchObject({ ok: false, reason: 'export-blocked' })
    expect(showOpenDialog).not.toHaveBeenCalled()

    const merge = await handlers.get(PDF_CHANNELS.mergePdf)?.(
      { sender: contents },
      { path, suggestedName: 'merged.pdf' },
    )
    expect(merge).toMatchObject({ ok: false, reason: 'export-blocked' })

    const mergedPages = await handlers.get(PDF_CHANNELS.mergePages)?.(
      { sender: contents },
      { path, perSheet: 2 },
    )
    expect(mergedPages).toMatchObject({ ok: false, reason: 'export-blocked' })
  })

  it('blocks export-images (the renderer already rasterized; nothing lands on disk)', async () => {
    const { contents } = await openDoc('cloud-only-pages.pdf')
    const blank = Buffer.from(await blankPdfBuffer()).toString('base64')

    const result = await handlers.get(PDF_CHANNELS.exportImages)?.(
      { sender: contents },
      { images: [blank], baseName: 'page' },
    )

    expect(result).toMatchObject({ ok: false, reason: 'export-blocked' })
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('lets a local/hybrid document extract unchanged (the gate only knows cloud-only)', async () => {
    const { path, contents } = await openDoc('local-working-copy.pdf')

    const result = (await handlers.get(PDF_CHANNELS.extractPages)?.(
      { sender: contents },
      { path, pages: [0], suggestedName: 'pages.pdf' },
    )) as { ok: boolean; savedPath?: string }

    expect(result.ok).toBe(true)
    expect(result.savedPath).toBeDefined()
    // the export really landed as a PDF file
    const bytes = await readFile(result.savedPath as string)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('no gate installed (standalone pdf) → nothing is ever blocked', async () => {
    setPdfCloudGate(null)
    const { path, contents } = await openDoc('cloud-only-standalone.pdf')

    const result = await handlers.get(PDF_CHANNELS.extractPages)?.(
      { sender: contents },
      { path, pages: [0], suggestedName: 'pages.pdf' },
    )

    expect(result).toMatchObject({ ok: true })
  })
})

describe('pdf print gate (Ruling 13 per-file policy)', () => {
  it('a cloud-only document with policy deny answers the typed block', async () => {
    const { contents } = await openDoc('cloud-only-print-deny.pdf')

    const verdict = await handlers.get(PDF_CHANNELS.printGate)?.({ sender: contents })

    expect(verdict).toEqual({ ok: false, error: 'blocked:print-blocked' })
  })

  it('policy allow (the default) prints; a local document prints regardless', async () => {
    const allowed = await openDoc('cloud-only-print-ok.pdf')
    expect(handlers.get(PDF_CHANNELS.printGate)?.({ sender: allowed.contents })).toEqual({
      ok: true,
    })

    const local = await openDoc('local-print-deny-naming-irrelevant.pdf')
    expect(handlers.get(PDF_CHANNELS.printGate)?.({ sender: local.contents })).toEqual({
      ok: true,
    })
  })
})
