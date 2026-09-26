/**
 * Storage-mode IPC wire contract (src/main/auth/storage-mode-ipc.ts) — the
 * cloud-docs-ipc.test.ts pattern: an electron-mocked `ipcMain` plus injected
 * seams. Focused on the `cloud:migrate-documents` edge: the payload schema,
 * and the direction guard — a migration may only run in a direction the
 * CURRENT mode can serve (the same matrix `migrationOfferFor` encodes:
 * upload after local → remote/hybrid, download after remote → local/hybrid,
 * both in hybrid), refused with the typed `no-such-migration` otherwise.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_MODE_CHANNELS } from '../src/shared/storage-mode-api'

// ── electron mock: captured handlers + one live webContents ──────────────

type Handler = (event: { sender: unknown }, payload?: unknown) => unknown

const handlers = new Map<string, Handler>()
const senderSend = vi.fn()

interface FakeSender {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
}
const sender: FakeSender = { id: 7, isDestroyed: () => false, send: senderSend }

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
  webContents: { getAllWebContents: () => [sender] },
}))

// ── the module's other default seams are not under test here ─────────────

vi.mock('../src/main/auth/ipc', () => ({
  getAuthSessionManager: () => undefined,
  getBackendClient: () => undefined,
}))

vi.mock('../src/main/auth/cloud-docs-ipc', () => ({
  getCloudDocumentsRegistry: () => undefined,
}))

vi.mock('@genoffice/electron-utils', () => ({
  configuredDefaultSaveDir: () => '/GenOffice',
}))

// ── fixtures ──────────────────────────────────────────────────────────────

let signedIn = false
/** local documents the upload migration would list */
let documents: string[] = []

async function loadIpc() {
  vi.resetModules()
  handlers.clear()
  senderSend.mockClear()
  signedIn = false
  documents = []
  const module = await import('../src/main/auth/storage-mode-ipc')
  module.registerStorageModeIpc({
    settingsPath: join(userDataDir, 'app-settings.json'),
    scratchDir: join(userDataDir, 'cloud-scratch'),
    associationIndexPath: join(userDataDir, 'cloud-document-index.json'),
    localRootDir: userDataDir,
    documentsDir: () => join(userDataDir, 'documents'),
    listLocalDocuments: () => documents,
    registry: () => undefined,
    sessionActive: () => signedIn,
    client: () => undefined,
    onExit: () => {},
  })
  return module
}

/** Invoke a registered handler the way ipcMain would (sync throws → rejections). */
function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`)
  return Promise.resolve().then(() => handler({ sender }, payload))
}

const migrate = (direction: string): Promise<unknown> =>
  invoke(STORAGE_MODE_CHANNELS.migrateDocuments, { direction })

const setMode = (mode: string): Promise<unknown> =>
  invoke(STORAGE_MODE_CHANNELS.setStorageMode, { mode })

describe('cloud:migrate-documents at the IPC edge', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'storage-mode-ipc-'))
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('refuses a direction the current mode cannot run, matrix-wide', async () => {
    await loadIpc()
    // local mode: only the download direction exists (remote → local's move)
    await expect(migrate('upload')).resolves.toEqual({ ok: false, error: 'no-such-migration' })

    // switch to remote (guarded behind the session): only upload exists now
    signedIn = true
    await setMode('remote')
    await expect(migrate('download')).resolves.toEqual({ ok: false, error: 'no-such-migration' })
    await expect(migrate('upload')).resolves.toEqual({ ok: true, moved: 0, failures: [] })

    // hybrid is reachable from either origin, so both of its directions exist
    await setMode('hybrid')
    await expect(migrate('upload')).resolves.toEqual({ ok: true, moved: 0, failures: [] })
    await expect(migrate('download')).resolves.toEqual({ ok: true, moved: 0, failures: [] })

    // back to local: download again, upload refused
    await setMode('local')
    await expect(migrate('download')).resolves.toEqual({ ok: true, moved: 0, failures: [] })
    await expect(migrate('upload')).resolves.toEqual({ ok: false, error: 'no-such-migration' })
  })

  it('runs the guard against the mode as it is NOW (a stale direction is refused)', async () => {
    await loadIpc()
    signedIn = true
    // while local, upload is refused…
    await expect(migrate('upload')).resolves.toEqual({ ok: false, error: 'no-such-migration' })
    await setMode('remote')
    // …the moment the mode is remote the same invoke runs (zero documents
    // here, so the move is empty but real)…
    await expect(migrate('upload')).resolves.toEqual({ ok: true, moved: 0, failures: [] })
    await setMode('local')
    // …and a migration dialog that outlived its switch is refused again
    await expect(migrate('upload')).resolves.toEqual({ ok: false, error: 'no-such-migration' })
  })

  it('still validates the payload before anything runs', async () => {
    await loadIpc()
    for (const payload of [
      undefined,
      {},
      { direction: 'sideways' },
      { direction: 'upload', extra: 1 },
      { direction: 42 },
    ]) {
      await expect(
        invoke(STORAGE_MODE_CHANNELS.migrateDocuments, payload),
        JSON.stringify(payload),
      ).rejects.toThrow()
    }
  })

  it('a legal direction still answers sign-in-required without a session', async () => {
    await loadIpc()
    // download is legal in local mode; the session gate inside the run fires
    await expect(migrate('download')).resolves.toEqual({ ok: false, error: 'sign-in-required' })
  })
})
