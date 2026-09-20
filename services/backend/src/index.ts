/**
 * Public surface of `@genoffice/backend` — composition pieces, exported so
 * tests and the integration script can boot the app in-process (no listen)
 * and later phases can register additional route plugins.
 */

export { buildApp, type BuildAppOptions } from './app.js'
export {
  ConfigError,
  DEFAULT_AUDIENCE,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_DB_PATH,
  DEFAULT_HOST,
  DEFAULT_ISSUER,
  DEFAULT_PORT,
  defaultJwksUrl,
  loadConfig,
  type BackendConfig,
} from './config.js'
export { ApiError, notFound } from './errors.js'
export { storagePlugin, type StorageOptions } from './plugins/storage.js'
export { BackendStore } from './storage/store.js'
export type {
  ChatAttachment,
  ChatMessage,
  ChatMessageInput,
  ChatRecord,
  ChatScope,
  ChatSummaryRecord,
  ProjectRecord,
  ToolActivity,
} from './storage/store.js'
export {
  verifyAuth,
  type AccessTokenClaims,
  type AuthErrorCode,
  type RequestAuth,
  type VerifyAuthOptions,
} from './plugins/verify-auth.js'
