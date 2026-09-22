/**
 * External-change detection now lives in @genoffice/document-store (the
 * DocumentStore abstraction the save/open handlers route through; the store
 * records disk states and compares them). This module remains as the
 * historical import path for the docs tests; there is one implementation.
 */
export { isExternallyModified } from '@genoffice/document-store'
export type { DiskFileState } from '@genoffice/document-store'
