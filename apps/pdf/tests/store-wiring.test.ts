import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Document-store wiring (Phase 7f, the docs pilot rolled out to pdf): with a
 * mock store injected at the `setPdfDocumentStore` seam, every open
 * document's byte movement goes through it — the routed open read grants the
 * view, the save applies its edits to the routed source bytes and hands the
 * result back through the store, an in-place page op writes through it, a
 * rename re-keys it, and a destroyed view drops its owner. The real
 * pdf-lib/pdfium pipelines run here against a real blank PDF, so the local
 * adapter end to end produces the same bytes on the same path as before.
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
  dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn() },
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
  showOpenDialogWithMemory: vi.fn(),
  showSaveDialogWithMemory: vi.fn(),
  installRendererProtocol: vi.fn(),
  registerRendererScheme: vi.fn(),
  rendererUrl: vi.fn(() => 'genoffice-app://pdf/index.html'),
}))

import { createPdfView, setPdfDocumentStore } from '../src/main/pdf-main'
import { blankPdfBuffer } from '../src/main/blank-pdf'
import { PDF_CHANNELS } from '../src/shared/ipc'

interface StoreMock {
  read: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  authorizeWrite: ReturnType<typeof vi.fn>
  renameOwnerPath: ReturnType<typeof vi.fn>
  forgetOwner: ReturnType<typeof vi.fn>
}

function makeStoreMock(readResult: Buffer): StoreMock {
  return {
    read: vi.fn(async () => readResult),
    write: vi.fn(async () => undefined),
    authorizeWrite: vi.fn(),
    renameOwnerPath: vi.fn(),
    forgetOwner: vi.fn(),
  }
}

function asStore(mock: StoreMock): DocumentStore {
  return mock as unknown as DocumentStore
}

let temporaryDirectories: string[] = []

async function createPdf(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-store-wiring-'))
  temporaryDirectories.push(directory)
  const pdfPath = join(directory, 'doc.pdf')
  await writeFile(pdfPath, await blankPdfBuffer())
  return pdfPath
}

beforeEach(() => {
  temporaryDirectories = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('pdf document-store wiring', () => {
  it('routes the open read through the store and grants the view', async () => {
    const pdfPath = await createPdf()
    const store = makeStoreMock(await readFile(pdfPath))
    setPdfDocumentStore(asStore(store))
    const view = createPdfView(pdfPath)
    const contents = view.webContents as unknown as FakeWebContents

    const bytes = await handlers.get(PDF_CHANNELS.readFile)?.({ sender: contents }, pdfPath)

    expect(store.read).toHaveBeenCalledWith({ path: pdfPath })
    expect(store.authorizeWrite).toHaveBeenCalledWith(contents.id, { path: pdfPath })
    // the bytes handed to the renderer are the routed ones
    expect(
      Buffer.from(bytes as ArrayBuffer)
        .subarray(0, 5)
        .toString('latin1'),
    ).toBe('%PDF-')
  })

  it('routes a save through the store: routed source, store write, no direct disk write', async () => {
    const pdfPath = await createPdf()
    const originalBytes = await readFile(pdfPath)
    const store = makeStoreMock(originalBytes)
    setPdfDocumentStore(asStore(store))
    const view = createPdfView(pdfPath)
    const contents = view.webContents as unknown as FakeWebContents

    const result = await handlers.get(PDF_CHANNELS.save)?.(
      { sender: contents },
      {
        path: pdfPath,
        markups: [],
        drawings: [],
        formValues: [],
        stamps: [],
      },
    )

    expect(result).toMatchObject({ ok: true })
    // the source came from the store (a remote document's server bytes)
    expect(store.read).toHaveBeenCalledWith({ path: pdfPath })
    // the result went back through the store as valid PDF bytes
    expect(store.write).toHaveBeenCalledTimes(1)
    const [ref, written] = store.write.mock.calls[0] as [{ path: string }, Buffer]
    expect(ref.path).toBe(pdfPath)
    expect(written.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    // the mock store never touches disk: the file behind the router must stay
    // at its old bytes, proving the write went through the store only
    await expect(readFile(pdfPath)).resolves.toEqual(originalBytes)
  })

  it('routes an in-place page op through the store', async () => {
    const pdfPath = await createPdf()
    const originalBytes = await readFile(pdfPath)
    const store = makeStoreMock(originalBytes)
    setPdfDocumentStore(asStore(store))
    const view = createPdfView(pdfPath)
    const contents = view.webContents as unknown as FakeWebContents

    const result = await handlers.get(PDF_CHANNELS.insertBlankPage)?.(
      { sender: contents },
      {
        path: pdfPath,
        afterPageIndex: -1,
      },
    )

    expect(result).toMatchObject({ ok: true })
    expect(store.read).toHaveBeenCalledWith({ path: pdfPath })
    expect(store.write).toHaveBeenCalledTimes(1)
    const [ref, written] = store.write.mock.calls[0] as [{ path: string }, Buffer]
    expect(ref.path).toBe(pdfPath)
    // the op actually happened: the merged output has two pages (bigger source)
    expect(written.length).toBeGreaterThan(originalBytes.length)
  })

  it('re-keys the store on a rename and drops the owner when the view dies', async () => {
    const pdfPath = await createPdf()
    const store = makeStoreMock(await readFile(pdfPath))
    setPdfDocumentStore(asStore(store))
    const view = createPdfView(pdfPath)
    const contents = view.webContents as unknown as FakeWebContents

    const { pdfFileRenamed } = await import('../src/main/pdf-main')
    const newPath = join(pdfPath, '..', 'renamed.pdf')
    pdfFileRenamed(contents as never, pdfPath, newPath)
    expect(store.renameOwnerPath).toHaveBeenCalledWith(contents.id, pdfPath, newPath)

    contents.listeners.get('destroyed')?.()
    expect(store.forgetOwner).toHaveBeenCalledWith(contents.id)
  })
})
