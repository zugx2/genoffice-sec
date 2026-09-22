export { LocalDocumentStore } from './local.js'
export { atomicWriteFile, looksLikeZip } from './atomic.js'
export { isExternallyModified } from './external-change.js'
export type {
  DiskFileState,
  DocumentRef,
  DocumentStat,
  DocumentStore,
  RecoveryStamp,
} from './types.js'
