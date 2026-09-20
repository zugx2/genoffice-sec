/**
 * Storage plugin — opens the SQLite store and exposes it as `app.store`.
 *
 * The handle is closed on app close (`onClose`), so `app.close()` in tests
 * and graceful shutdown in `server.ts` both release it cleanly. Wrapped in
 * `fastify-plugin` so the decoration crosses encapsulation boundaries (same
 * pattern as `verifyAuth`).
 */

import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { BackendStore } from '../storage/store.js'

export interface StorageOptions {
  /** SQLite path: `:memory:` or a file path (see `BackendStore`) */
  dbPath: string
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Sub-scoped projects/chats persistence (see `BackendStore`) */
    store: BackendStore
  }
}

export const storagePlugin = fp(
  async (app: FastifyInstance, options: StorageOptions): Promise<void> => {
    const store = new BackendStore(options.dbPath)
    app.decorate('store', store)
    app.addHook('onClose', async () => {
      store.close()
    })
  },
  { name: 'storage' },
)
