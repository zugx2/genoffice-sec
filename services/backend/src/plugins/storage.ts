/**
 * Storage plugin — opens the SQLite store and the document byte store and
 * exposes them as `app.store` / `app.files`.
 *
 * The SQLite handle is closed on app close (`onClose`), so `app.close()` in
 * tests and graceful shutdown in `server.ts` both release it cleanly. The
 * byte store holds no handle. Both decorations are wrapped in
 * `fastify-plugin` so they cross encapsulation boundaries (same pattern as
 * `verifyAuth`).
 */

import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { DocumentFileStore } from '../storage/document-files.js'
import { BackendStore } from '../storage/store.js'

export interface StorageOptions {
  /** SQLite path: `:memory:` or a file path (see `BackendStore`) */
  dbPath: string
  /** Root directory for document bytes (see `DocumentFileStore`) */
  dataDir: string
  /**
   * Per-version byte cap override. Production keeps the documented 200 MiB
   * default; the app factory exposes this only so unit tests can exercise
   * the 413 path cheaply.
   */
  maxDocumentBytes?: number
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Sub-scoped projects/chats/document-metadata persistence (see `BackendStore`) */
    store: BackendStore
    /** Sub-scoped document byte storage (see `DocumentFileStore`) */
    files: DocumentFileStore
  }
}

export const storagePlugin = fp(
  async (app: FastifyInstance, options: StorageOptions): Promise<void> => {
    const store = new BackendStore(options.dbPath)
    const files = new DocumentFileStore(options.dataDir, options.maxDocumentBytes ?? undefined)
    app.decorate('store', store)
    app.decorate('files', files)
    app.addHook('onClose', async () => {
      store.close()
    })
  },
  { name: 'storage' },
)
