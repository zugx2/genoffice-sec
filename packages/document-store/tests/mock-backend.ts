/**
 * In-memory stand-in for the backend's documents API
 * (services/backend/src/routes/documents.ts) — the contract the remote and
 * hybrid adapters are written against, spoken by a fake transport.
 *
 * Uploads are parsed with undici's own `Request.formData()` (an independent
 * multipart parser), so a passing round-trip also proves the adapter's
 * hand-rolled encoder emits genuinely parseable bodies: field names
 * (`name`/`kind` + one file part), the bare-integer `If-Match`/ETag policy,
 * 409 `version_conflict` on a stale guard, `?conflict=copy` storing a NEW
 * document beside the untouched original, and 404s for missing ids.
 */

import { createHash, randomUUID } from 'node:crypto'

/** One uploaded file part as the mock parsed it. */
export interface MockFilePart {
  /** The form field the bytes arrived under. */
  field: string
  filename: string
  bytes: Buffer
}

/** Every request the transport saw, in order. */
export interface RecordedRequest {
  method: string
  path: string
  /** Lowercased header names, exactly as sent. */
  headers: Record<string, string>
  /** The raw body bytes (uploads), or null. */
  rawBody: Buffer | null
  /** Parsed multipart fields (uploads only). */
  fields: Record<string, string> | null
  /** The single file part (uploads only). */
  file: MockFilePart | null
}

interface MockDocument {
  id: string
  name: string
  kind: string
  createdAt: string
  updatedAt: string
  /** version v's bytes sit at index v-1; the counter never rewinds */
  versions: Buffer[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

const nowIso = () => new Date().toISOString()

/**
 * What the mock needs from a parsed form. Declared structurally because the
 * DOM lib that vitest's types pull in shadows the global `FormData` with an
 * empty interface, hiding undici's iteration methods at type level only.
 */
interface ParsedForm {
  forEach: (callback: (value: string | ParsedFile, key: string) => void) => void
}

interface ParsedFile {
  name: string
  arrayBuffer(): Promise<ArrayBuffer>
}

export class MockDocumentBackend {
  readonly requests: RecordedRequest[] = []
  /** Transport calls to fail outright (network-down simulation), consumed first. */
  failNext = 0
  /** When set, every request stalls this long (concurrency tests). */
  delayMs = 0
  /** When set, the next upload (POST/PUT) is answered with this rejection. */
  rejectNextUpload: { status: number; code: string } | null = null

  private readonly documents = new Map<string, MockDocument>()

  /** The transport seam: hand this to the adapters' constructors. */
  readonly transport = async (path: string, init?: RequestInit): Promise<Response> => {
    if (this.failNext > 0) {
      this.failNext -= 1
      throw new TypeError('fetch failed')
    }
    if (this.delayMs > 0) await sleep(this.delayMs)
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    const headerRecord = init?.headers as Record<string, string> | undefined
    for (const [name, value] of Object.entries(headerRecord ?? {})) {
      headers[name.toLowerCase()] = String(value)
    }
    let rawBody: Buffer | null = null
    let fields: Record<string, string> | null = null
    let file: MockFilePart | null = null
    if (init?.body != null) {
      rawBody = Buffer.from(init.body as ArrayBuffer)
      if ((headers['content-type'] ?? '').startsWith('multipart/')) {
        const parsed = (await new Request(`http://mock.local${path}`, {
          method,
          headers: init.headers,
          body: init.body,
        }).formData()) as unknown as ParsedForm
        fields = {}
        let binary: { field: string; value: ParsedFile } | null = null
        parsed.forEach((value, field) => {
          if (typeof value === 'string') fields![field] = value
          else binary = { field, value }
        })
        if (binary !== null) {
          const part = binary as { field: string; value: ParsedFile }
          file = {
            field: part.field,
            filename: part.value.name,
            bytes: Buffer.from(await part.value.arrayBuffer()),
          }
        }
      }
    }
    this.requests.push({ method, path, headers, rawBody, fields, file })
    return this.route(method, path, headers, fields, file)
  }

  // ── test-side state helpers ───────────────────────────────

  /** Another device's upload: appends a version with no guard at all. */
  bumpVersion(id: string, bytes = Buffer.from('another device saved first')): void {
    const doc = this.documents.get(id)
    if (doc === undefined) throw new Error(`mock has no document ${id}`)
    doc.versions.push(bytes)
    doc.updatedAt = nowIso()
  }

  /** Hard-deletes a document (another device / data reset). */
  hardDelete(id: string): void {
    this.documents.delete(id)
  }

  bytesOf(id: string): Buffer {
    const doc = this.documents.get(id)
    if (doc === undefined) throw new Error(`mock has no document ${id}`)
    return doc.versions[doc.versions.length - 1]!
  }

  /** Creates a document as another device would, returning its id. */
  seedDocument(name = 'seeded.docx', bytes = Buffer.from('seeded bytes')): string {
    return this.create(name, 'docx', bytes).id
  }

  // ── routing (the T12 contract subset the adapters use) ────

  private route(
    method: string,
    path: string,
    headers: Record<string, string>,
    fields: Record<string, string> | null,
    file: MockFilePart | null,
  ): Response {
    if (method === 'GET' && path === '/documents') {
      return jsonResponse(200, { documents: [...this.documents.values()].map(summaryOf) })
    }
    let match = /^\/documents\/([^/?]+)$/.exec(path)
    if (method === 'GET' && match !== null) {
      const doc = this.documents.get(match[1]!)
      if (doc === undefined) return errorResponse(404, 'not_found')
      return new Response(new Uint8Array(this.bytesOf(doc.id)), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          // the bare integer the If-Match guard accepts, not an RFC-quoted ETag
          etag: String(doc.versions.length),
          'content-disposition': `attachment; filename="${doc.name}"`,
        },
      })
    }
    if (method === 'POST' && path === '/documents') {
      if (this.rejectNextUpload !== null) return this.rejectedUpload()
      if (fields === null || file === null) return errorResponse(400, 'validation_failed')
      if (fields.name === undefined || fields.kind === undefined) {
        return errorResponse(400, 'validation_failed')
      }
      return jsonResponse(201, this.create(fields.name, fields.kind, file.bytes))
    }
    match = /^\/documents\/([^/?]+)(\?conflict=copy)?$/.exec(path)
    if (method === 'PUT' && match !== null) {
      if (this.rejectNextUpload !== null) return this.rejectedUpload()
      const doc = this.documents.get(match[1]!)
      if (doc === undefined) return errorResponse(404, 'not_found')
      if (fields === null || file === null) return errorResponse(400, 'validation_failed')
      if (match[2] !== undefined) {
        // the conflict copy: a NEW document, fresh version chain, original untouched
        const copy = this.create(
          `${fields.name ?? doc.name} (conflict ${nowIso()})`,
          fields.kind ?? doc.kind,
          file.bytes,
        )
        return jsonResponse(201, copy)
      }
      const expected = headers['if-match']
      if (expected !== undefined && Number(expected) !== doc.versions.length) {
        return errorResponse(409, 'version_conflict')
      }
      doc.versions.push(file.bytes)
      doc.updatedAt = nowIso()
      if (fields.name !== undefined) doc.name = fields.name
      if (fields.kind !== undefined) doc.kind = fields.kind
      return jsonResponse(200, summaryOf(doc))
    }
    match = /^\/documents\/([^/?]+)$/.exec(path)
    if (method === 'DELETE' && match !== null) {
      const doc = this.documents.get(match[1]!)
      if (doc === undefined) return errorResponse(404, 'not_found')
      const expected = headers['if-match']
      if (expected !== undefined && Number(expected) !== doc.versions.length) {
        return errorResponse(409, 'version_conflict')
      }
      this.documents.delete(doc.id)
      return new Response(null, { status: 204 })
    }
    return errorResponse(404, 'not_found')
  }

  private rejectedUpload(): Response {
    const rejection = this.rejectNextUpload!
    this.rejectNextUpload = null
    return errorResponse(rejection.status, rejection.code)
  }

  private create(name: string, kind: string, bytes: Buffer) {
    const id = randomUUID()
    const doc: MockDocument = {
      id,
      name,
      kind,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      versions: [bytes],
    }
    this.documents.set(id, doc)
    return summaryOf(doc)
  }
}

function summaryOf(doc: MockDocument) {
  const bytes = doc.versions[doc.versions.length - 1]!
  return {
    id: doc.id,
    name: doc.name,
    kind: doc.kind,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    currentVersion: doc.versions.length,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { error: { code, message: code } })
}
