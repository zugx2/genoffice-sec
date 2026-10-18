import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentStore } from '@genoffice/document-store'

/**
 * Ruling 13 export gate (docs): with the shell's cloud gate injected at
 * `setDocsCloudGate` and the active document tracked per tab (set on
 * `docs:open-path`), the export/print handlers answer the typed block for a
 * cloud-only document before any dialog or byte write, while a local
 * document flows through to the (canceled) save dialog unchanged. The heavy
 * docx/ai machinery is mocked — only the gate's path classification and the
 * handlers' first moves are under test.
 */

type IpcHandler = (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown

interface FakeWebContents {
  id: number
  isDestroyed: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

// hoisted: docs-main registers some handlers at module import time, before
// the test file's own declarations run
const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
const showSaveDialogWithMemory = vi.hoisted(() => vi.fn())
const showMessageBox = vi.hoisted(() => vi.fn(async () => ({ response: 0 })))
let nextWebContentsId = 1

function makeWebContents(): FakeWebContents {
  return {
    id: nextWebContentsId++,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  }
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
    name: 'GenOffice',
    getVersion: vi.fn(() => '0.0.0-test'),
    whenReady: vi.fn(() => new Promise(() => {})),
    on: vi.fn(),
    quit: vi.fn(),
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
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => []) },
  WebContentsView: class {},
  clipboard: { write: vi.fn() },
  dialog: { showMessageBox, showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
  nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => true })) },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  webContents: { getAllWebContents: () => [] },
}))

vi.mock('@genoffice/electron-utils', () => ({
  appMenuLabels: vi.fn(() => ({})),
  buildPrintableHtml: vi.fn(() => ''),
  configuredDefaultSaveDir: vi.fn(() => tmpdir()),
  contextMenuLabels: vi.fn(() => ({})),
  fetchRemoteImage: vi.fn(),
  installContextMenu: vi.fn(),
  installNavigationGuard: vi.fn(),
  isHeadlessMode: vi.fn(() => false),
  printHtmlToPdf: vi.fn(async () => Buffer.alloc(0)),
  safeExternalUrl: vi.fn(() => null),
  saveAsSuggestion: vi.fn(() => null),
  saveImageFromUrl: vi.fn(async () => ({ ok: false })),
  showOpenDialogWithMemory: vi.fn(),
  showSaveDialogWithMemory,
  aboutMenuItem: vi.fn(() => ({})),
  checkUpdatesMenuItem: vi.fn(() => ({})),
  toggleDevToolsItem: vi.fn(() => ({})),
  windowMenuTemplate: vi.fn(() => []),
  installRendererProtocol: vi.fn(),
  registerRendererScheme: vi.fn(),
  rendererUrl: vi.fn(() => 'genoffice-app://docs/index.html'),
}))

vi.mock('@genoffice/font-metrics', () => ({
  configureMetricsCache: vi.fn(),
  familyVerticalMetrics: vi.fn(() => ({})),
}))
vi.mock('@genoffice/project-store', () => ({
  LocalProjectApi: class {},
  ProjectStore: class {},
}))
vi.mock('@genoffice/file-parse', () => ({ parseFileToText: vi.fn(async () => '') }))
vi.mock('../../../../packages/html2docx/src', () => ({ convertHtmlToDocx: vi.fn() }))
vi.mock('../../../../packages/html2docx/src/drivers/electron', () => ({
  ElectronBrowserDriver: class {
    static create() {
      return Promise.resolve(new this())
    }
    close() {
      return Promise.resolve()
    }
  },
}))
vi.mock('@genoffice/ai-provider', () => ({
  AiCreditsError: class extends Error {},
  AiTimeoutError: class extends Error {},
  isAiNetworkError: vi.fn(() => false),
  isAiOverloadedError: vi.fn(() => false),
  chatForProvider: vi.fn(),
  defaultAiSettings: vi.fn(() => ({})),
  activeProvider: vi.fn(() => 'genspark'),
  testMediaProvider: vi.fn(),
  resolveAiSettings: vi.fn(() => ({})),
  maxOutputTokensOf: vi.fn(() => 4096),
  setAiUserAgent: vi.fn(),
  setRescueFetch: vi.fn(),
  streamForProvider: vi.fn(),
}))
vi.mock('@genoffice/ai-provider/codex-app-server', () => ({
  listCodexModels: vi.fn(async () => []),
  shutdownCodexAppServers: vi.fn(),
}))
vi.mock('@genoffice/ai-search', () => ({
  ensureGenofficeLogin: vi.fn(),
  gskApiKey: vi.fn(() => null),
  generateImageTool: vi.fn(),
  testSearchProvider: vi.fn(),
  gskLoginInfo: vi.fn(),
  hasGskAuth: vi.fn(() => false),
  webSearchTool: vi.fn(),
  imageSearchTool: vi.fn(),
}))
vi.mock('../src/main/lazy-media', () => ({
  adoptLazyMediaHashes: vi.fn(async () => undefined),
  forgetLazyMediaOwner: vi.fn(),
  materializeLazyDocx: vi.fn(async (bytes: Buffer) => ({ bytes, hashes: {} })),
  openLazyDocx: vi.fn(async () => undefined),
  pointLazyMediaAt: vi.fn(),
  readLazyMedia: vi.fn(async () => null),
  registerLazyMediaProtocol: vi.fn(),
}))
vi.mock('../src/main/docx-encryption', () => ({
  commitDocPasswordSave: vi.fn(() => false),
  currentDocPasswordIntentRevision: vi.fn(() => 0),
  decryptDocx: vi.fn(),
  decryptRecoveryCopy: vi.fn(),
  discardDocPasswordIntents: vi.fn(),
  DocxDecryptError: class extends Error {},
  docPasswordFor: vi.fn(() => null),
  encryptDocx: vi.fn((bytes: Buffer) => bytes),
  forgetDocPasswords: vi.fn(),
  isEncryptedDocx: vi.fn(() => false),
  markDiskEncrypted: vi.fn(),
  prepareRecoveryDocx: vi.fn(() => Buffer.alloc(0)),
  rememberDocPassword: vi.fn(),
  renameDocPassword: vi.fn(),
  setDocPassword: vi.fn(),
  snapshotDocPassword: vi.fn(() => ({ password: null })),
}))
vi.mock('../src/main/updater', () => ({ initDocsAutoUpdater: vi.fn() }))
vi.mock('../src/main/zotero-ipc', () => ({
  registerZoteroIpc: vi.fn(),
  teardownZoteroIpc: vi.fn(),
}))

import { registerDocsIpc, setDocsCloudGate, setDocumentStore } from '../src/main/docs-main'

/** The shell's gate stand-in: paths tagged `cloud-only` are remote-mode,
 * `print-deny` carries a deny policy; messages are marker strings. */
const gate = {
  isCloudOnlyPath: (path: string): boolean => path.includes('cloud-only'),
  printPolicy: (path: string): 'allow' | 'deny' => (path.includes('print-deny') ? 'deny' : 'allow'),
  blockedMessage: (reason: 'export-blocked' | 'print-blocked'): string => `blocked:${reason}`,
}

function makeStoreMock(): DocumentStore {
  return {
    exists: vi.fn(async () => true),
    stat: vi.fn(async () => ({ size: 100, mtimeMs: 1 })),
    read: vi.fn(async () => Buffer.from('PK docx bytes')),
    write: vi.fn(async () => undefined),
    hashBytes: vi.fn(() => 'a'.repeat(64)),
    archiveOriginal: vi.fn(async () => undefined),
    authorizeWrite: vi.fn(),
    canWrite: vi.fn(async () => true),
    recoveryStamp: vi.fn(() => null),
    recordDiskState: vi.fn(async () => undefined),
    changedExternally: vi.fn(async () => false),
    forgetOwner: vi.fn(),
    clearRecovery: vi.fn(),
  } as unknown as DocumentStore
}

let directory: string

async function openDoc(name: string): Promise<FakeWebContents> {
  const path = join(directory, name)
  setDocumentStore(makeStoreMock())
  const contents = makeWebContents()
  const result = await handlers.get('docs:open-path')?.({ sender: contents }, path)
  expect(result, 'open must succeed for the gate test').toMatchObject({ path })
  return contents
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'docs-export-gate-'))
  showSaveDialogWithMemory.mockReset()
  showMessageBox.mockClear()
  setDocsCloudGate(gate)
  registerDocsIpc()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('docs export gate (Ruling 13)', () => {
  it('open-path registers the tab document; cloud-only export-pdf answers the typed block', async () => {
    const contents = await openDoc('cloud-only-report.docx')

    const result = await handlers.get('docs:export-pdf')?.(
      { sender: contents },
      'report.docx',
      12240,
      15840,
    )

    expect(result).toEqual({ ok: false, reason: 'export-blocked', error: 'blocked:export-blocked' })
    // blocked before any destination dialog
    expect(showSaveDialogWithMemory).not.toHaveBeenCalled()
  })

  it('blocks export-html and save-merged-pdf as well', async () => {
    const contents = await openDoc('cloud-only-page.docx')

    const html = await handlers.get('docs:export-html')?.(
      { sender: contents },
      'page.docx',
      '<p>x</p>',
    )
    expect(html).toMatchObject({ ok: false, reason: 'export-blocked' })

    const merged = await handlers.get('docs:save-merged-pdf')?.(
      { sender: contents },
      'page.docx',
      [],
    )
    expect(merged).toMatchObject({ ok: false, reason: 'export-blocked' })
  })

  it('blocks print only when the per-file policy denies; allow proceeds', async () => {
    const denied = await openDoc('cloud-only-print-deny.docx')
    const blocked = await handlers.get('docs:print')?.({ sender: denied })
    expect(blocked).toEqual({ ok: false, reason: 'print-blocked', error: 'blocked:print-blocked' })

    // policy allow (default): past the gate — the handler reaches sender.print,
    // which this fake lacks; the rejection proves the gate did not block
    const allowed = await openDoc('cloud-only-print-ok.docx')
    await expect(handlers.get('docs:print')?.({ sender: allowed })).rejects.toThrow(
      /print is not a function/i,
    )
  })

  it('lets a local/hybrid document export unchanged (gate passes to the dialog)', async () => {
    const contents = await openDoc('local-report.docx')
    showSaveDialogWithMemory.mockResolvedValue({ canceled: true })

    const result = await handlers.get('docs:export-pdf')?.(
      { sender: contents },
      'report.docx',
      12240,
      15840,
    )

    // reached the (canceled) save dialog: the gate did not interfere
    expect(result).toEqual({ ok: false })
    expect(showSaveDialogWithMemory).toHaveBeenCalledTimes(1)
  })
})
