/**
 * `/documents` — document CRUD with version history, scoped to the verified
 * `sub` (Phase 7a; `docs/cloud-backend-auth.md` "Document storage modes").
 *
 * A document is named, typed (`docx`/`xlsx`/`pptx`/`pdf`/`md`/`html`), and
 * versioned: POST creates version 1, PUT appends a version row and bumps the
 * document's monotonic counter — the `If-Match`/ETag value, same policy as
 * projects/chats (absent header = last-writer-wins, stale header = 409
 * `version_conflict`, non-integer = 400). Metadata lives in SQLite
 * (`app.store`); bytes on disk under `<dataDir>/<sub>/<docId>/<version>`
 * (`app.files`), never indexed by filename.
 *
 * Uploads come in two shapes and **multipart is the primary one** (streamed,
 * per-part limits, no total-size ambiguity); `application/octet-stream` raw
 * bodies with `name`/`kind` query params are the documented fallback for
 * trivial clients. Both feed the same streaming byte meter — a request is
 * never buffered whole, and the 200 MiB cap trips on the first byte past it
 * (413 `payload_too_large`, staged bytes discarded).
 *
 * Conflict copies (the design's hybrid-mode semantics): a stale PUT never
 * overwrites — the client re-uploads with `?conflict=copy` and the server
 * stores those bytes as a NEW document named `<name> (conflict <UTC ISO>)`
 * with a fresh version chain (201). The client-side mechanism lands in
 * Phase 7's adapters; this endpoint only makes it possible.
 *
 * Missing and foreign ids answer the same 404 — no existence leak — and
 * byte isolation is structural: the disk tree is keyed by `sub` and every
 * query is `WHERE sub = ?`.
 */

import multipart from '@fastify/multipart'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import {
  ApiError,
  notFound,
  payloadTooLarge,
  unsupportedMediaType,
  versionConflict,
} from '../errors.js'
import {
  DocumentFileMissingError,
  DocumentIntegrityError,
  type DocumentFileStore,
  type StoredBlob,
} from '../storage/document-files.js'
import { ifMatchVersion } from './if-match.js'
import { requireSub } from './sub.js'

/** Document kinds the API accepts (the suite's editable formats). */
export const DOCUMENT_KINDS = ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'html'] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

/** Name caps mirror the projects resource (non-blank, trimmed, bounded). */
const NAME_MAX_LENGTH = 255

// ── JSON schemas (fastify's built-in ajv validation; no extra deps) ──
// Upload bodies are streams/multipart, so `schema.body` is never set. The
// querystring schema covers the raw path's `name`/`kind` channel and the
// shared `conflict` switch; multipart form fields are validated to the same
// rules by parseName/parseKind below.

const uploadQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', pattern: '\\S', maxLength: NAME_MAX_LENGTH },
    kind: { enum: [...DOCUMENT_KINDS] },
    conflict: { type: 'string', pattern: '^copy$' },
  },
} as const

const documentIdParamSchema = {
  type: 'object',
  required: ['documentId'],
  additionalProperties: false,
  properties: { documentId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const

const versionParamsSchema = {
  type: 'object',
  required: ['documentId', 'version'],
  additionalProperties: false,
  properties: {
    documentId: { type: 'string', minLength: 1, maxLength: 128 },
    // No type coercion (see buildApp ajv options): 1–10 digits keeps the
    // parsed number inside Number.MAX_SAFE_INTEGER.
    version: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' },
  },
} as const

// ── Field validation, shared by the multipart and raw channels ──

function invalid(message: string): never {
  throw new ApiError(400, 'validation_failed', message)
}

/** Trims and validates a document name (the query schema's rule, applied to form fields). */
function parseName(field: string, raw: unknown): string {
  if (typeof raw !== 'string') invalid(`${field} is required`)
  const name = raw.trim()
  if (name === '') invalid(`${field} must not be blank`)
  if (name.length > NAME_MAX_LENGTH) invalid(`${field} exceeds ${NAME_MAX_LENGTH} characters`)
  return name
}

/** Validates a document kind against the supported set. */
function parseKind(raw: unknown): DocumentKind {
  if (typeof raw !== 'string') invalid('kind is required')
  if (!(DOCUMENT_KINDS as readonly string[]).includes(raw)) {
    invalid(`kind must be one of ${DOCUMENT_KINDS.join(', ')}`)
  }
  return raw as DocumentKind
}

/** Validated `name`/`kind`/`conflict` from the query string (ajv already checked shapes). */
interface QueryMeta {
  name?: string
  kind?: DocumentKind
  conflictCopy: boolean
}

function queryMeta(request: FastifyRequest): QueryMeta {
  const query = request.query as { name?: string; kind?: string; conflict?: string }
  return {
    name: query.name === undefined ? undefined : parseName('name', query.name),
    kind: query.kind === undefined ? undefined : parseKind(query.kind),
    conflictCopy: query.conflict === 'copy',
  }
}

// ── Upload reading (multipart primary, raw fallback) ──

interface Upload {
  /** Metadata sent with the bytes (absent fields keep the stored values). */
  name?: string
  kind?: DocumentKind
  blob: StoredBlob
}

/**
 * Reads one upload body into `stage`. Multipart: `name`/`kind` form fields
 * plus exactly one file part — unknown or repeated fields, and a second
 * file part, are 400s, the same strictness `additionalProperties: false`
 * gives JSON bodies. Raw: the octet-stream body, with metadata from the
 * query string. `stage` writes the bytes straight to its staging file, so
 * nothing is held in memory and an error discards what was staged.
 */
async function readUpload(
  request: FastifyRequest,
  query: QueryMeta,
  maxBytes: number,
  stage: (source: Readable) => Promise<StoredBlob>,
): Promise<Upload> {
  if (request.isMultipart()) {
    if (query.name !== undefined || query.kind !== undefined) {
      invalid('name/kind belong in form fields for multipart uploads')
    }
    const fields: Record<string, string> = {}
    let blob: StoredBlob | undefined
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname !== 'name' && part.fieldname !== 'kind') {
            invalid(`unknown multipart field "${part.fieldname}"`)
          }
          if (part.fieldname in fields) invalid(`duplicate multipart field "${part.fieldname}"`)
          fields[part.fieldname] = String(part.value)
          continue
        }
        if (blob !== undefined) invalid('exactly one file part is allowed')
        blob = await stage(part.file)
        // busboy truncates a part at its size limit instead of erroring;
        // the meter fires first at the same threshold, this catches the rest.
        if (part.file.truncated) throw payloadTooLarge()
      }
    } catch (err) {
      // @fastify/multipart reports its own limits as fastify errors; give
      // them the same stable 413 code the byte meter uses.
      if ((err as { statusCode?: number }).statusCode === 413) throw payloadTooLarge()
      throw err
    }
    if (blob === undefined) invalid('a file part is required')
    return {
      name: fields.name === undefined ? undefined : parseName('name', fields.name),
      kind: fields.kind === undefined ? undefined : parseKind(fields.kind),
      blob,
    }
  }

  if (
    !String(request.headers['content-type'] ?? '')
      .toLowerCase()
      .startsWith('application/octet-stream')
  ) {
    throw unsupportedMediaType()
  }
  // Fastify's bodyLimit only guards parsers that buffer the body, and this
  // parser deliberately passes the stream through — so the Content-Length
  // precheck lives here: an oversized declared body is rejected before a
  // single byte is read. (Chunked bodies have no length to check; the byte
  // meter bounds those.)
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw payloadTooLarge()
  const body = request.body
  if (body === undefined || typeof (body as Readable).pipe !== 'function') {
    invalid('a request body is required')
  }
  return { ...query, blob: await stage(body as Readable) }
}

// ── Per-document write lock ────────────────────────────────────────────

const documentLocks = new Map<string, Promise<undefined>>()

/**
 * In-process write mutex per `sub`+document. Staging a version awaits disk
 * IO while the SQLite commit is synchronous, so without serialization two
 * concurrent PUTs (or a PUT racing a DELETE) could both act on
 * `current + 1`. The lock makes read-version → stage → commit → prune one
 * atomic sequence within this process — the deployment shape (single
 * writer on one SQLite file).
 */
async function withDocumentLock<T>(
  sub: string,
  documentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${sub}\u0000${documentId}`
  const previous = documentLocks.get(key) ?? Promise.resolve(undefined)
  const run = previous.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  documentLocks.set(key, tail)
  void tail.then(() => {
    if (documentLocks.get(key) === tail) documentLocks.delete(key)
  })
  return run
}

// ── Download replies ───────────────────────────────────────────────────

/** RFC 6266 attachment header: an ASCII fallback plus the UTF-8 encoded form. */
function contentDisposition(name: string): string {
  const fallback = name
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .trim()
  const safe = fallback === '' ? 'document' : fallback
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Streams a stored version as the reply, after re-hashing it: a mismatch or
 * a vanished file is a server-side fault, logged with the details here and
 * answered with the generic 500 — the client learns nothing about paths.
 */
async function sendVersion(
  files: DocumentFileStore,
  request: FastifyRequest,
  reply: FastifyReply,
  sub: string,
  documentId: string,
  version: { version: number; sha256: string },
  name: string,
): Promise<FastifyReply> {
  try {
    await files.verifyVersion(sub, documentId, version.version, version.sha256)
    const stream = await files.openVersion(sub, documentId, version.version)
    return (
      reply
        .header('content-type', 'application/octet-stream')
        // Deliberately the bare integer the If-Match guard accepts — the same
        // "version is the entity tag" convention as projects/chats, not an
        // RFC-quoted ETag.
        .header('etag', String(version.version))
        .header('content-disposition', contentDisposition(name))
        .send(stream)
    )
  } catch (err) {
    if (err instanceof DocumentIntegrityError || err instanceof DocumentFileMissingError) {
      request.log.error(
        { err: { name: err.name, message: err.message }, documentId, version: version.version },
        'stored document version failed its integrity/availability check',
      )
      // The replacement message is deliberately path-free; the cause keeps
      // the typed detail for anyone inspecting the error server-side.
      throw new Error('stored document is unreadable', { cause: err })
    }
    throw err
  }
}

// ── Routes ─────────────────────────────────────────────────────────────

export const documentRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  // One byte cap everywhere: the streaming meter, busboy's part limit (a
  // byte above the cap, so the meter always trips first and discards its
  // own staging file), and fastify's Content-Length precheck for raw bodies.
  const uploadCap = app.files.maxBytes
  await app.register(multipart, {
    limits: {
      fileSize: uploadCap + 1,
      // 2 files so the SECOND file part reaches our own 400 ("exactly one
      // file part") instead of a busboy files-limit error.
      files: 2,
      fields: 8,
      fieldSize: 2 * 1024,
      parts: 12,
    },
  })
  // Raw uploads keep the body a stream — the handler pipes it to disk, so a
  // 200 MiB upload is never buffered in memory. Note fastify's `bodyLimit`
  // only guards parsers that buffer (`parseAs`), so it is deliberately not
  // set here: the Content-Length precheck in readUpload and the streaming
  // byte meter are the enforcement.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload)
  })

  app.get('/documents', { preHandler: [app.authenticate] }, async (request) => {
    const sub = requireSub(request)
    return { documents: app.store.listDocuments(sub) }
  })

  app.post(
    '/documents',
    { preHandler: [app.authenticate], schema: { querystring: uploadQuerySchema } },
    async (request, reply) => {
      const sub = requireSub(request)
      // The id is minted here, not in the store: bytes are staged before any
      // row exists, so a failure orphans a file (inert) instead of a row.
      const documentId = randomUUID()
      let upload: Upload
      try {
        upload = await readUpload(request, queryMeta(request), uploadCap, (source) =>
          app.files.writeVersion(sub, documentId, 1, source),
        )
        parseName('name', upload.name)
        parseKind(upload.kind)
      } catch (err) {
        await app.files.removeDocument(sub, documentId).catch((cleanupErr: unknown) => {
          app.log.warn({ err: cleanupErr }, 'failed to discard staged document bytes')
        })
        throw err
      }
      const record = app.store.createDocument(
        sub,
        documentId,
        upload.name as string,
        upload.kind as DocumentKind,
        upload.blob,
      )
      return reply.code(201).send(record)
    },
  )

  app.get<{ Params: { documentId: string } }>(
    '/documents/:documentId',
    { preHandler: [app.authenticate], schema: { params: documentIdParamSchema } },
    async (request, reply) => {
      const sub = requireSub(request)
      const document = app.store.getDocument(sub, request.params.documentId)
      if (document === null) throw notFound()
      return sendVersion(
        app.files,
        request,
        reply,
        sub,
        document.id,
        { version: document.currentVersion, sha256: document.sha256 },
        document.name,
      )
    },
  )

  app.put<{ Params: { documentId: string } }>(
    '/documents/:documentId',
    {
      preHandler: [app.authenticate],
      schema: { params: documentIdParamSchema, querystring: uploadQuerySchema },
    },
    async (request, reply) => {
      const sub = requireSub(request)
      const expected = ifMatchVersion(request)
      const query = queryMeta(request)
      // The guard runs before any byte is read — a 404/409 costs no disk IO;
      // the unconsumed body is drained so the connection stays reusable.
      const current = app.store.getDocument(sub, request.params.documentId)
      if (current === null) {
        request.raw.resume()
        throw notFound()
      }
      if (query.conflictCopy) {
        // Store the upload as a NEW document (fresh id, version chain from
        // 1); the original is left untouched.
        const copyId = randomUUID()
        let upload: Upload
        try {
          upload = await readUpload(request, query, uploadCap, (source) =>
            app.files.writeVersion(sub, copyId, 1, source),
          )
          parseName('name', upload.name ?? current.name)
          parseKind(upload.kind ?? current.kind)
        } catch (err) {
          await app.files.removeDocument(sub, copyId).catch((cleanupErr: unknown) => {
            app.log.warn({ err: cleanupErr }, 'failed to discard staged conflict-copy bytes')
          })
          throw err
        }
        const record = app.store.createDocument(
          sub,
          copyId,
          `${upload.name ?? current.name} (conflict ${new Date().toISOString()})`,
          (upload.kind ?? current.kind) as DocumentKind,
          upload.blob,
        )
        return reply.code(201).send(record)
      }
      if (expected !== undefined && current.currentVersion !== expected) {
        request.raw.resume()
        throw versionConflict()
      }
      return withDocumentLock(sub, current.id, async () => {
        // Re-read under the lock: the guard above used an unlocked snapshot
        // (cheap 404/409 fast path), but the staged version number must be
        // the committed one, so the fresh read wins here — including a
        // re-check of If-Match against it.
        const locked = app.store.getDocument(sub, current.id)
        if (locked === null) throw notFound()
        if (expected !== undefined && locked.currentVersion !== expected) throw versionConflict()
        const stagedVersion = locked.currentVersion + 1
        let record: Awaited<ReturnType<typeof app.store.getDocument>>
        try {
          const upload = await readUpload(request, query, uploadCap, (source) =>
            app.files.writeVersion(sub, current.id, stagedVersion, source),
          )
          if (upload.name !== undefined) parseName('name', upload.name)
          if (upload.kind !== undefined) parseKind(upload.kind)
          const result = app.store.addDocumentVersion(sub, current.id, upload.blob, {
            name: upload.name,
            kind: upload.kind,
          })
          if (result === null) throw notFound()
          if (result.record.currentVersion !== stagedVersion) {
            // Unreachable under the in-process lock (single process per
            // SQLite file); recorded because a mismatch would mean a
            // committed row whose bytes sit under another version number.
            app.log.error(
              { documentId: current.id, stagedVersion, committed: result.record.currentVersion },
              'document version number moved under the write lock',
            )
          }
          record = result.record
          // Pruned rows are gone; their files follow once the rows are
          // committed (a failure here orphans bytes, never a row).
          await app.files
            .removeVersions(sub, current.id, result.pruned)
            .catch((cleanupErr: unknown) => {
              app.log.warn({ err: cleanupErr }, 'failed to delete pruned version files')
            })
        } catch (err) {
          await app.files
            .removeVersions(sub, current.id, [stagedVersion])
            .catch((cleanupErr: unknown) => {
              app.log.warn({ err: cleanupErr }, 'failed to discard staged document version')
            })
          throw err
        }
        return reply.send(record)
      })
    },
  )

  app.delete<{ Params: { documentId: string } }>(
    '/documents/:documentId',
    { preHandler: [app.authenticate], schema: { params: documentIdParamSchema } },
    async (request, reply) => {
      const sub = requireSub(request)
      const expected = ifMatchVersion(request)
      return withDocumentLock(sub, request.params.documentId, async () => {
        const current = app.store.documentVersion(sub, request.params.documentId)
        if (current === null) throw notFound()
        if (expected !== undefined && current !== expected) throw versionConflict()
        if (!app.store.deleteDocument(sub, request.params.documentId)) throw notFound()
        try {
          await app.files.removeDocument(sub, request.params.documentId)
        } catch (err) {
          // Rows are gone, so the document is unreachable either way; the
          // orphaned bytes are an operator cleanup item, not a client error.
          request.log.error({ err }, 'failed to delete document bytes after removing rows')
        }
        return reply.code(204).send()
      })
    },
  )

  app.get<{ Params: { documentId: string } }>(
    '/documents/:documentId/versions',
    { preHandler: [app.authenticate], schema: { params: documentIdParamSchema } },
    async (request) => {
      const sub = requireSub(request)
      const versions = app.store.listDocumentVersions(sub, request.params.documentId)
      if (versions === null) throw notFound()
      return { versions }
    },
  )

  app.get<{ Params: { documentId: string; version: string } }>(
    '/documents/:documentId/versions/:version',
    { preHandler: [app.authenticate], schema: { params: versionParamsSchema } },
    async (request, reply) => {
      const sub = requireSub(request)
      const document = app.store.getDocument(sub, request.params.documentId)
      if (document === null) throw notFound()
      const version = app.store.getDocumentVersion(
        sub,
        request.params.documentId,
        Number(request.params.version),
      )
      if (version === null) throw notFound()
      return sendVersion(
        app.files,
        request,
        reply,
        sub,
        request.params.documentId,
        version,
        document.name,
      )
    },
  )
}
