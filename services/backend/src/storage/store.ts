/**
 * SQLite persistence for projects and chats, scoped by `sub`.
 *
 * Node's built-in `node:sqlite` (Node ≥ 22.5; no native deps) backs this
 * store. Schema and query rules:
 *
 * - **Every table carries `sub`** and **every statement filters
 *   `WHERE sub = ?`** — including deletes. There is no method on this class
 *   that can touch another user's rows: `sub` is the first parameter of
 *   every public method and is bound into every prepared statement.
 * - Cross-table cleanup (deleting a project removes its chats and their
 *   messages) is done with explicit sub-scoped statements inside a
 *   transaction, not `ON DELETE CASCADE` — the scoping stays visible in the
 *   SQL itself.
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

function nowIso(): string {
  return new Date().toISOString()
}

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
}
