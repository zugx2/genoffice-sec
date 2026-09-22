/**
 * Atomic-write + zip-sanity primitives now live in @genoffice/document-store
 * (the DocumentStore abstraction the save/open handlers route through). This
 * module remains as the historical import path for docs-main and the docs
 * tests; there is one implementation.
 */
export { atomicWriteFile, looksLikeZip } from '@genoffice/document-store'
