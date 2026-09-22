/**
 * SQLite persistence for projects, chats, and document metadata, scoped by
 * `sub`.
 *
 * Node's built-in `node:sqlite` (Node ≥ 22.5; no native deps) backs this
 * store. Schema and query rules:
 *
 * - **Every table carries `sub`** and **every statement filters
 *   `WHERE sub = ?`** — including deletes. There is no method on this class
 *   that can touch another user's rows: `sub` is the first parameter of
 *   every public method and is bound into every prepared statement.
 * - Cross-table cleanup (deleting a project removes its chats and their
 *   messages; deleting a document removes its version rows) is done with
 *   explicit sub-scoped statements inside a transaction, not
 *   `ON DELETE CASCADE` — the scoping stays visible in the SQL itself.
 * - All statements are prepared once and cached; user-supplied values are
 *   only ever bound as parameters (no string interpolation into SQL).
 *
 * The data model mirrors `packages/project-store` (the local filesystem
 * store this API serves remotely): a project is `{name, files}`; a chat
 * belongs to exactly one project and is an ordered list of messages with a
 * store-assigned monotonically increasing `seq` (full replace renumbers
 * 1..n by array position). Every mutable record carries `updatedAt` (UTC
 * ISO) and a monotonic integer `version` (starts at 1, +1 on every
 * successful mutation) for the client-side conflict policy.
 *
 * Documents (Phase 7a) keep only metadata here — one row per document plus
 * one row per retained version (`size` + `sha256`); the bytes live in
 * `storage/document-files.ts`, keyed by the same `sub`/`documentId`.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

// ────────────────────────────────────────────────────────────
// Record types (mirrors of packages/project-store/src/types.ts)
// ────────────────────────────────────────────────────────────

export interface ToolActivity {
  name: string
  summary: string
  isError?: boolean
  /** Tool input (JSON-serialized) */
  input?: string
  /** Tool output */
  output?: string
}

/** Attachment metadata recorded with a user message (reference only, no bytes) */
export interface ChatAttachment {
  name: string
  path?: string
  ext?: string
  sizeBytes?: number
}

/** What a user message was scoped to: a caption plus an excerpt of the selected content */
export interface ChatScope {
  label: string
  text?: string
}

/** One chat message; `seq`/`ts` are assigned by the store. */
export interface ChatMessage {
  seq: number
  /** UTC ISO string */
  ts: string
  role: 'user' | 'assistant'
  text: string
  /** File path associated with the message */
  fileRef?: string
  tools?: ToolActivity[]
  attachments?: ChatAttachment[]
  scope?: ChatScope
}

/** A message as accepted from a client (seq is server-assigned, ts optional). */
export type ChatMessageInput = Omit<ChatMessage, 'seq' | 'ts'> & { ts?: string }

export interface ProjectRecord {
  id: string
  name: string
  files: string[]
  createdAt: string
  updatedAt: string
  version: number
}

export interface ChatSummaryRecord {
  id: string
  createdAt: string
  updatedAt: string
  version: number
  messageCount: number
}

export interface ChatRecord extends ChatSummaryRecord {
  projectId: string
  messages: ChatMessage[]
}

// ────────────────────────────────────────────────────────────
// Document records (bytes live in storage/document-files.ts)
// ────────────────────────────────────────────────────────────

/**
 * One stored document version. `version` is the document's monotonic counter
 * value at the time this row was written; files live at
 * `<dataDir>/<sub>/<documentId>/<version>`.
 */
export interface DocumentVersionRecord {
  version: number
  size: number
  /** sha256 hex digest of the stored bytes */
  sha256: string
  /** UTC ISO string */
  createdAt: string
}

/** List-item shape: metadata only, no bytes (`currentVersion` = If-Match value). */
export interface DocumentSummaryRecord {
  id: string
  name: string
  /** Document kind (`docx`/`xlsx`/`pptx`/`pdf`/`md`/`html`, validated by the routes) */
  kind: string
  /** Byte size of the current version */
  size: number
  /** Monotonic version counter — the `If-Match` / download ETag value */
  currentVersion: number
  /** UTC ISO string */
  createdAt: string
  /** UTC ISO string */
  updatedAt: string
}

/** Full metadata record returned by create/update (adds the current sha256). */
export interface DocumentRecord extends DocumentSummaryRecord {
  /** sha256 hex digest of the current version's bytes */
  sha256: string
}

// ────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,
  name       TEXT NOT NULL,
  files      TEXT NOT NULL, -- JSON array of file paths
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_by_sub ON projects (sub, created_at, id);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_by_project ON chats (sub, project_id, created_at, id);

CREATE TABLE IF NOT EXISTS chat_messages (
  sub        TEXT NOT NULL,
  project_id TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL, -- full ChatMessage JSON (with store-assigned seq/ts)
  PRIMARY KEY (sub, project_id, chat_id, seq)
);

CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_by_sub ON documents (sub, created_at, id);

CREATE TABLE IF NOT EXISTS document_versions (
  sub         TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (sub, document_id, version)
);
`

interface ProjectRow {
  id: string
  sub: string
  name: string
  files: string
  created_at: string
  updated_at: string
  version: number
}

interface ChatRow {
  id: string
  sub: string
  project_id: string
  created_at: string
  updated_at: string
  version: number
  message_count?: number
}

interface DocumentRow {
  id: string
  sub: string
  name: string
  kind: string
  created_at: string
  updated_at: string
  current_version: number
  size: number
  sha256: string
}

interface DocumentVersionRow {
  version: number
  size: number
  sha256: string
  created_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Version rows kept per document (brief ruling 4: oldest pruned on insert). */
export const MAX_DOCUMENT_VERSIONS = 50

// ────────────────────────────────────────────────────────────
// Store
// ────────────────────────────────────────────────────────────

/**
 * Sub-scoped persistence. Construct with a SQLite path (`:memory:` or a
 * file); `close()` releases the handle (wired to the app's `onClose`).
 */
export class BackendStore {
  readonly #db: DatabaseSync
  readonly #statements = new Map<string, StatementSync>()

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
    }
    this.#db = new DatabaseSync(dbPath)
    if (dbPath !== ':memory:') {
      this.#db.exec('PRAGMA journal_mode = WAL;')
    }
    this.#db.exec(SCHEMA_SQL)
  }

  /** Prepared-statement cache: each SQL string is compiled exactly once. */
  #stmt(sql: string): StatementSync {
    let statement = this.#statements.get(sql)
    if (statement === undefined) {
      statement = this.#db.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }

  #withTransaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  #projectFromRow(row: ProjectRow): ProjectRecord {
    return {
      id: row.id,
      name: row.name,
      files: JSON.parse(row.files) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    }
  }

  #chatSummaryFromRow(row: ChatRow): ChatSummaryRecord {
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
      messageCount: row.message_count ?? 0,
    }
  }

  #documentFromRow(row: DocumentRow): DocumentRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      size: row.size,
      sha256: row.sha256,
      currentVersion: row.current_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** True when the project id exists for this sub (foreign ids read as absent). */
  #projectExists(sub: string, projectId: string): boolean {
    return (
      this.#stmt('SELECT 1 AS ok FROM projects WHERE sub = ? AND id = ?').get(sub, projectId) !==
      undefined
    )
  }

  close(): void {
    this.#db.close()
  }

  // ── Projects ──────────────────────────────────────────────

  /** All projects of this sub, oldest first (creation order, stable). */
  listProjects(sub: string): ProjectRecord[] {
    const rows = this.#stmt(
      'SELECT id, sub, name, files, created_at, updated_at, version FROM projects WHERE sub = ? ORDER BY created_at ASC, id ASC',
    ).all(sub) as unknown as ProjectRow[]
    return rows.map((row) => this.#projectFromRow(row))
  }

  createProject(sub: string, name: string): ProjectRecord {
    const now = nowIso()
    const row = this.#stmt(
      'INSERT INTO projects (id, sub, name, files, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id, sub, name, files, created_at, updated_at, version',
    ).get(randomUUID(), sub, name, '[]', now, now) as unknown as ProjectRow
    return this.#projectFromRow(row)
  }

  /** Project by id, or null when it does not exist **for this sub**. */
  getProject(sub: string, projectId: string): ProjectRecord | null {
    const row = this.#stmt(
      'SELECT id, sub, name, files, created_at, updated_at, version FROM projects WHERE sub = ? AND id = ?',
    ).get(sub, projectId) as unknown as ProjectRow | undefined
    return row === undefined ? null : this.#projectFromRow(row)
  }

  /**
   * Full-object replace (name + files); bumps `version` and `updatedAt`.
   * Returns the updated record, or null when not found for this sub.
   */
  updateProject(
    sub: string,
    projectId: string,
    name: string,
    files: string[],
  ): ProjectRecord | null {
    const row = this.#stmt(
      `UPDATE projects
          SET name = ?, files = ?, updated_at = ?, version = version + 1
        WHERE sub = ? AND id = ?
      RETURNING id, sub, name, files, created_at, updated_at, version`,
    ).get(name, JSON.stringify(files), nowIso(), sub, projectId) as unknown as
      ProjectRow | undefined
    return row === undefined ? null : this.#projectFromRow(row)
  }

  /**
   * Hard delete of the project and everything nested under it (chats and
   * their messages), all sub-scoped. Returns false when not found for this
   * sub (nothing was deleted).
   */
  deleteProject(sub: string, projectId: string): boolean {
    return this.#withTransaction(() => {
      if (!this.#projectExists(sub, projectId)) return false
      this.#stmt('DELETE FROM chat_messages WHERE sub = ? AND project_id = ?').run(sub, projectId)
      this.#stmt('DELETE FROM chats WHERE sub = ? AND project_id = ?').run(sub, projectId)
      this.#stmt('DELETE FROM projects WHERE sub = ? AND id = ?').run(sub, projectId)
      return true
    })
  }

  // ── Chats (always nested under an owned project) ──────────

  /**
   * Chat summaries of one project, oldest first. Returns null when the
   * project does not exist for this sub (foreign/missing — caller maps both
   * to 404).
   */
  listChats(sub: string, projectId: string): ChatSummaryRecord[] | null {
    if (!this.#projectExists(sub, projectId)) return null
    const rows = this.#stmt(
      `SELECT c.id, c.sub, c.project_id, c.created_at, c.updated_at, c.version,
              (SELECT COUNT(*) FROM chat_messages m
                WHERE m.sub = c.sub AND m.project_id = c.project_id AND m.chat_id = c.id)
                AS message_count
         FROM chats c
        WHERE c.sub = ? AND c.project_id = ?
        ORDER BY c.created_at ASC, c.id ASC`,
    ).all(sub, projectId) as unknown as ChatRow[]
    return rows.map((row) => this.#chatSummaryFromRow(row))
  }

  /** Creates an empty chat under the project; null when the project is not this sub's. */
  createChat(sub: string, projectId: string): ChatRecord | null {
    const now = nowIso()
    const id = randomUUID()
    return this.#withTransaction(() => {
      if (!this.#projectExists(sub, projectId)) return null
      this.#stmt(
        'INSERT INTO chats (id, sub, project_id, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)',
      ).run(id, sub, projectId, now, now)
      return {
        id,
        projectId,
        createdAt: now,
        updatedAt: now,
        version: 1,
        messageCount: 0,
        messages: [],
      } satisfies ChatRecord
    })
  }

  #chatRow(sub: string, projectId: string, chatId: string): ChatRow | undefined {
    return this.#stmt(
      `SELECT c.id, c.sub, c.project_id, c.created_at, c.updated_at, c.version,
              (SELECT COUNT(*) FROM chat_messages m
                WHERE m.sub = c.sub AND m.project_id = c.project_id AND m.chat_id = c.id)
                AS message_count
         FROM chats c
        WHERE c.sub = ? AND c.project_id = ? AND c.id = ?`,
    ).get(sub, projectId, chatId) as unknown as ChatRow | undefined
  }

  #messages(sub: string, projectId: string, chatId: string, limit?: number): ChatMessage[] {
    const rows = this.#stmt(
      'SELECT payload FROM chat_messages WHERE sub = ? AND project_id = ? AND chat_id = ? ORDER BY seq ASC',
    ).all(sub, projectId, chatId) as unknown as { payload: string }[]
    const messages = rows.map((row) => JSON.parse(row.payload) as ChatMessage)
    // Mirrors project-store loadChat: the MOST RECENT `limit` messages,
    // still returned in ascending seq order.
    return limit === undefined ? messages : messages.slice(-limit)
  }

  /**
   * Full chat (messages ascending by seq; `limit` keeps the most recent N).
   * Null when the chat — or its project — is not this sub's.
   */
  getChat(sub: string, projectId: string, chatId: string, limit?: number): ChatRecord | null {
    const row = this.#chatRow(sub, projectId, chatId)
    if (row === undefined) return null
    const messages = this.#messages(sub, projectId, chatId, limit)
    return {
      id: row.id,
      projectId: row.project_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
      messageCount: row.message_count ?? 0,
      messages,
    }
  }

  /**
   * Current `version` of the chat, or null when the chat — or its project —
   * is not this sub's. The `If-Match` conflict guard reads it without
   * loading the message list.
   */
  chatVersion(sub: string, projectId: string, chatId: string): number | null {
    const row = this.#chatRow(sub, projectId, chatId)
    return row === undefined ? null : row.version
  }

  /**
   * Full replace of the message list. The store assigns `seq` (1..n by
   * array position) and `ts` (client-provided value or now); `version` and
   * `updatedAt` bump. Null when the chat/project is not this sub's.
   */
  updateChat(
    sub: string,
    projectId: string,
    chatId: string,
    input: ChatMessageInput[],
  ): ChatRecord | null {
    const now = nowIso()
    const messages: ChatMessage[] = input.map((msg, index) => ({
      ...msg,
      seq: index + 1,
      ts: msg.ts ?? now,
    }))
    return this.#withTransaction(() => {
      const row = this.#stmt(
        `UPDATE chats
            SET updated_at = ?, version = version + 1
          WHERE sub = ? AND project_id = ? AND id = ?
        RETURNING id, sub, project_id, created_at, updated_at, version`,
      ).get(now, sub, projectId, chatId) as unknown as ChatRow | undefined
      if (row === undefined) return null
      this.#stmt('DELETE FROM chat_messages WHERE sub = ? AND project_id = ? AND chat_id = ?').run(
        sub,
        projectId,
        chatId,
      )
      const insert = this.#stmt(
        'INSERT INTO chat_messages (sub, project_id, chat_id, seq, payload) VALUES (?, ?, ?, ?, ?)',
      )
      for (const msg of messages) {
        insert.run(sub, projectId, chatId, msg.seq, JSON.stringify(msg))
      }
      return {
        id: row.id,
        projectId: row.project_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
        messageCount: messages.length,
        messages,
      } satisfies ChatRecord
    })
  }

  /**
   * Hard delete of the chat and its messages, sub-scoped. False when not
   * found for this sub.
   */
  deleteChat(sub: string, projectId: string, chatId: string): boolean {
    return this.#withTransaction(() => {
      const existing = this.#chatRow(sub, projectId, chatId)
      if (existing === undefined) return false
      this.#stmt('DELETE FROM chat_messages WHERE sub = ? AND project_id = ? AND chat_id = ?').run(
        sub,
        projectId,
        chatId,
      )
      this.#stmt('DELETE FROM chats WHERE sub = ? AND project_id = ? AND id = ?').run(
        sub,
        projectId,
        chatId,
      )
      return true
    })
  }

  // ── Documents (metadata + version rows; bytes on disk) ────

  /** Document row joined with its current version, or undefined. */
  #documentRow(sub: string, documentId: string): DocumentRow | undefined {
    return this.#stmt(
      `SELECT d.id, d.sub, d.name, d.kind, d.created_at, d.updated_at,
              d.version AS current_version, v.size, v.sha256
         FROM documents d
         JOIN document_versions v
           ON v.sub = d.sub AND v.document_id = d.id AND v.version = d.version
        WHERE d.sub = ? AND d.id = ?`,
    ).get(sub, documentId) as unknown as DocumentRow | undefined
  }

  /**
   * All documents of this sub with their current version's size, oldest
   * first (creation order, stable — same convention as projects/chats).
   */
  listDocuments(sub: string): DocumentSummaryRecord[] {
    const rows = this.#stmt(
      `SELECT d.id, d.sub, d.name, d.kind, d.created_at, d.updated_at,
              d.version AS current_version, v.size
         FROM documents d
         JOIN document_versions v
           ON v.sub = d.sub AND v.document_id = d.id AND v.version = d.version
        WHERE d.sub = ?
        ORDER BY d.created_at ASC, d.id ASC`,
    ).all(sub) as unknown as Array<Omit<DocumentRow, 'sha256'>>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      size: row.size,
      currentVersion: row.current_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  /** Full metadata record, or null when not found **for this sub**. */
  getDocument(sub: string, documentId: string): DocumentRecord | null {
    const row = this.#documentRow(sub, documentId)
    return row === undefined ? null : this.#documentFromRow(row)
  }

  /**
   * Current `version` of the document, or null when it is not this sub's —
   * the `If-Match` conflict guard reads it without loading rows for bytes.
   */
  documentVersion(sub: string, documentId: string): number | null {
    const row = this.#stmt('SELECT version FROM documents WHERE sub = ? AND id = ?').get(
      sub,
      documentId,
    ) as unknown as { version: number } | undefined
    return row === undefined ? null : row.version
  }

  /**
   * Inserts a new document (version 1) together with its first version row.
   * The id is caller-assigned: the bytes are staged on disk before any row
   * exists (see storage/document-files.ts), so the route mints the UUID.
   */
  createDocument(
    sub: string,
    documentId: string,
    name: string,
    kind: string,
    blob: { size: number; sha256: string },
  ): DocumentRecord {
    const now = nowIso()
    return this.#withTransaction(() => {
      this.#stmt(
        'INSERT INTO documents (id, sub, name, kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)',
      ).run(documentId, sub, name, kind, now, now)
      this.#stmt(
        'INSERT INTO document_versions (sub, document_id, version, size, sha256, created_at) VALUES (?, ?, 1, ?, ?, ?)',
      ).run(sub, documentId, blob.size, blob.sha256, now)
      return {
        id: documentId,
        name,
        kind,
        size: blob.size,
        sha256: blob.sha256,
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies DocumentRecord
    })
  }

  /**
   * Appends the next version row and bumps the document's counter (and,
   * when given, its name/kind). Oldest versions beyond
   * {@link MAX_DOCUMENT_VERSIONS} are pruned **in the same transaction**;
   * the pruned version numbers are returned so the caller can drop their
   * files after the commit. Null when the document is not this sub's.
   *
   * The authoritative new version number is the UPDATE's RETURNING value
   * (`record.currentVersion`): callers stage bytes at `current + 1` under a
   * per-document lock and reconcile on a mismatch (a writer that slipped
   * past the lock) — see routes/documents.ts.
   */
  addDocumentVersion(
    sub: string,
    documentId: string,
    blob: { size: number; sha256: string },
    meta?: { name?: string; kind?: string },
  ): { record: DocumentRecord; pruned: number[] } | null {
    const now = nowIso()
    return this.#withTransaction(() => {
      const row = this.#stmt(
        `UPDATE documents
            SET name = COALESCE(?, name), kind = COALESCE(?, kind),
                updated_at = ?, version = version + 1
          WHERE sub = ? AND id = ?
        RETURNING id, sub, name, kind, created_at, updated_at,
                  version AS current_version`,
      ).get(meta?.name ?? null, meta?.kind ?? null, now, sub, documentId) as unknown as
        Omit<DocumentRow, 'size' | 'sha256'> | undefined
      if (row === undefined) return null
      this.#stmt(
        'INSERT INTO document_versions (sub, document_id, version, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(sub, documentId, row.current_version, blob.size, blob.sha256, now)
      // Version numbers are contiguous 1..n (append-only, pruned from the
      // low end), so "older than the newest MAX" is a plain cutoff.
      const cutoff = row.current_version - MAX_DOCUMENT_VERSIONS
      const pruned =
        cutoff < 1
          ? []
          : (
              this.#stmt(
                'SELECT version FROM document_versions WHERE sub = ? AND document_id = ? AND version <= ? ORDER BY version ASC',
              ).all(sub, documentId, cutoff) as unknown as Array<{ version: number }>
            ).map((r) => r.version)
      if (pruned.length > 0) {
        this.#stmt(
          'DELETE FROM document_versions WHERE sub = ? AND document_id = ? AND version <= ?',
        ).run(sub, documentId, cutoff)
      }
      const current = this.#stmt(
        'SELECT size, sha256 FROM document_versions WHERE sub = ? AND document_id = ? AND version = ?',
      ).get(sub, documentId, row.current_version) as unknown as { size: number; sha256: string }
      return {
        record: {
          id: row.id,
          name: row.name,
          kind: row.kind,
          size: current.size,
          sha256: current.sha256,
          currentVersion: row.current_version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        pruned,
      }
    })
  }

  /**
   * Version history of a document, newest first (a history reads latest
   * entry first; every other list in this API stays oldest-first — this one
   * is deliberately reversed and documented as such). Null when the document
   * is not this sub's.
   */
  listDocumentVersions(sub: string, documentId: string): DocumentVersionRecord[] | null {
    if (this.documentVersion(sub, documentId) === null) return null
    const rows = this.#stmt(
      'SELECT version, size, sha256, created_at FROM document_versions WHERE sub = ? AND document_id = ? ORDER BY version DESC',
    ).all(sub, documentId) as unknown as DocumentVersionRow[]
    return rows.map((row) => ({
      version: row.version,
      size: row.size,
      sha256: row.sha256,
      createdAt: row.created_at,
    }))
  }

  /**
   * One version row (for downloading history entries), or null when the
   * document or that version is not this sub's — including a pruned version,
   * which reads exactly like a missing one.
   */
  getDocumentVersion(
    sub: string,
    documentId: string,
    version: number,
  ): DocumentVersionRecord | null {
    const row = this.#stmt(
      'SELECT version, size, sha256, created_at FROM document_versions WHERE sub = ? AND document_id = ? AND version = ?',
    ).get(sub, documentId, version) as unknown as DocumentVersionRow | undefined
    if (row === undefined) return null
    return {
      version: row.version,
      size: row.size,
      sha256: row.sha256,
      createdAt: row.created_at,
    }
  }

  /**
   * Hard delete of the document row and all its version rows, sub-scoped.
   * False when not found for this sub. The bytes are the caller's to remove
   * after this returns true.
   */
  deleteDocument(sub: string, documentId: string): boolean {
    return this.#withTransaction(() => {
      if (this.documentVersion(sub, documentId) === null) return false
      this.#stmt('DELETE FROM document_versions WHERE sub = ? AND document_id = ?').run(
        sub,
        documentId,
      )
      this.#stmt('DELETE FROM documents WHERE sub = ? AND id = ?').run(sub, documentId)
      return true
    })
  }
}
