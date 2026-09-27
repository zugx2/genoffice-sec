import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Document-store wiring (Phase 7f, the docs pilot rolled out to markdown):
 * with a mock store injected at the `setMarkdownDocumentStore` seam, every
 * document byte movement goes through it — the routed open read grants the
 * view, the save writes through the store, the MCP silent save records its
 * grant there, a rename re-keys it, and a destroyed view drops its owner —
 * plus one end-to-end run against the REAL local adapter proving `local`
 * mode writes the same bytes to the same path it always did.
 */

type IpcHandler = (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown

interface FakeWebContents {
  id: number
  listeners: Map<string, () => void>
  isDestroyed: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
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
    loadFile: vi.fn(),
    loadURL: vi.fn(),
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
  dialog: { showMessageBox: vi.fn() },
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
  rendererUrl: vi.fn(() => 'genoffice-app://markdown/index.html'),
  safeExternalUrl: vi.fn(() => null),
  showOpenDialogWithMemory: vi.fn(),
  showSaveDialogWithMemory: vi.fn(),
}))

import {
  createMarkdownView,
  markdownFileRenamed,
  markdownSaveToPath,
  setMarkdownDocumentStore,
} from '../src/main/markdown-main'
import { MARKDOWN_CHANNELS } from '../src/shared/ipc'

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

async function createDocument(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-store-wiring-'))
  temporaryDirectories.push(directory)
  const documentPath = join(directory, 'note.md')
  await writeFile(documentPath, content)
  return documentPath
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

describe('markdown document-store wiring', () => {
  it('routes the open read through the store and grants the view', async () => {
    const documentPath = await createDocument('# old bytes on disk')
    const store = makeStoreMock(Buffer.from('# routed bytes'))
    setMarkdownDocumentStore(asStore(store))
    const view = createMarkdownView(documentPath)
    const contents = view.webContents as unknown as FakeWebContents

    const text = await handlers.get(MARKDOWN_CHANNELS.readFile)?.(
      { sender: contents },
      documentPath,
    )

    expect(text).toBe('# routed bytes')
    expect(store.read).toHaveBeenCalledWith({ path: documentPath })
    expect(store.authorizeWrite).toHaveBeenCalledWith(contents.id, { path: documentPath })
  })

  it('routes a save through the store (and not onto the disk copy behind it)', async () => {
    const documentPath = await createDocument('# original')
    const store = makeStoreMock(Buffer.from('# original'))
    setMarkdownDocumentStore(asStore(store))
    const view = createMarkdownView(documentPath)
    const contents = view.webContents as unknown as FakeWebContents
    handlers.get(MARKDOWN_CHANNELS.dirtyChanged)?.({ sender: contents }, true)

    const result = await handlers.get(MARKDOWN_CHANNELS.save)?.(
      { sender: contents },
      {
        text: '# routed save',
        mode: 'save',
      },
    )

    expect(result).toMatchObject({ ok: true, path: documentPath })
    expect(store.write).toHaveBeenCalledWith(
      { path: documentPath },
      Buffer.from('# routed save', 'utf8'),
    )
    // the mock store never touches disk: the file behind the router must stay
    // at its old bytes, proving the write went through the store only
    await expect(readFile(documentPath, 'utf8')).resolves.toBe('# original')
  })

  it('grants the MCP silent-save target through the store', async () => {
    const documentPath = await createDocument('# original')
    const target = join(documentPath, '..', 'mcp-target.md')
    const store = makeStoreMock(Buffer.from('# original'))
    setMarkdownDocumentStore(asStore(store))
    const view = createMarkdownView(documentPath)
    const contents = view.webContents as unknown as FakeWebContents

    const done = markdownSaveToPath(contents as never, target)
    // the renderer half of the silent save: the save request arrives here
    await handlers.get(MARKDOWN_CHANNELS.save)?.(
      { sender: contents },
      {
        text: '# via mcp',
        mode: 'save',
      },
    )
    await expect(done).resolves.toBeUndefined()

    expect(store.authorizeWrite).toHaveBeenCalledWith(contents.id, { path: target })
    expect(store.write).toHaveBeenCalledWith({ path: target }, Buffer.from('# via mcp', 'utf8'))
  })

  it('re-keys the store on a rename and drops the owner when the view dies', async () => {
    const documentPath = await createDocument('# original')
    const newPath = `${documentPath}.renamed.md`
    const store = makeStoreMock(Buffer.from('# original'))
    setMarkdownDocumentStore(asStore(store))
    const view = createMarkdownView(documentPath)
    const contents = view.webContents as unknown as FakeWebContents

    markdownFileRenamed(contents as never, documentPath, newPath)
    expect(store.renameOwnerPath).toHaveBeenCalledWith(contents.id, documentPath, newPath)

    contents.listeners.get('destroyed')?.()
    expect(store.forgetOwner).toHaveBeenCalledWith(contents.id)
  })

  it('keeps local-mode bytes identical end to end (the real local adapter)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'markdown-store-local-'))
    temporaryDirectories.push(directory)
    const documentPath = join(directory, 'note.md')
    await writeFile(documentPath, '# original')
    setMarkdownDocumentStore(
      new (await import('@genoffice/document-store')).LocalDocumentStore(directory),
    )
    const view = createMarkdownView(documentPath)
    const contents = view.webContents as unknown as FakeWebContents

    const result = await handlers.get(MARKDOWN_CHANNELS.save)?.(
      { sender: contents },
      {
        text: '# saved locally',
        mode: 'save',
      },
    )

    expect(result).toMatchObject({ ok: true, path: documentPath })
    await expect(readFile(documentPath, 'utf8')).resolves.toBe('# saved locally')
    // re-opening through the store returns exactly the saved bytes
    const readBack = await handlers.get(MARKDOWN_CHANNELS.readFile)?.(
      { sender: contents },
      documentPath,
    )
    expect(readBack).toBe('# saved locally')
  })
})
