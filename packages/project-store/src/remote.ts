/**
 * Remote `ProjectApi` — the same four-operation surface the local store
 * serves (`resolveChat` / `appendChat` / `loadChat` / `rebindChat`), mapped
 * onto the cloud backend's projects/chats REST surface (services/backend).
 *
 * Electron-free by injection: the transport is a `(path, init) => Response`
 * seam that already carries the base URL and authentication (the shell's
 * backend client — Bearer attach + refresh-once-on-401), and the client-side
 * index is a JSON file at an injected path. No URL, token, or Electron
 * import ever appears here. Sheets' `sessionId` → path resolution stays in
 * the shell's IPC layer, so this adapter only ever sees `filePath`.
 *
 * ## How the append-oriented local model maps onto CRUD
 *
 * The backend assigns UUID ids and only speaks full-record CRUD, while the
 * renderer knows files and stable per-file chat ids. The bridge is a
 * client-side index — the remote twin of the local `index.json`:
 *
 * - `resolveChat` stays pure: a path's chat id is the same sha256-derived
 *   id the local store uses, so no request is needed and the id is stable
 *   across restarts and across local/remote mode. `args.projectId` is the
 *   alias `'default'` (every ProjectApi chat lives in the account's
 *   server-side default project); the adapter never consults it — the
 *   index is authoritative for where a chat lives;
 * - the index records which server chat UUID backs each id, lazily: a chat
 *   row is created (`POST …/chats`) when the first message is appended, so
 *   an aborted first request leaves no empty record behind (the local
 *   store's buffered-first-write rule, achieved by laziness instead);
 * - `appendChat` is a read-modify-write: `GET` the message list, append the
 *   new message, `PUT` the full list back with `If-Match: <version>` — the
 *   version the GET reported. A concurrent writer bumps the server's
 *   version first and the PUT answers 409, which surfaces as a typed
 *   {@link RemoteProjectConflictError}. There is NO automatic merge and NO
 *   silent overwrite (docs/cloud-backend-auth.md, "Phase 6 conflict &
 *   routing policy"): a conflicted append is dropped and the caller sees
 *   the typed error. Mutations are serialized through one queue per
 *   adapter, so a panel's back-to-back user/assistant messages cannot
 *   conflict with each other — only with another device;
 * - `loadChat` mirrors the local tolerance: an id the index has never
 *   mapped (or the server no longer has) reads as an empty history;
 * - `rebindChat` moves a temp chat's messages into the target chat with the
 *   same merge the local store does (the target's history first, then the
 *   moved messages; the server renumbers seq 1..n on the replace), guarded
 *   by the target's `If-Match` version, then deletes the temp chat
 *   best-effort.
 *
 * Field caps are the local store's truncation constants, applied BEFORE
 * upload because the API rejects (400) where the local store truncates
 * silently. The one deliberate difference: the `[truncated]` mark is
 * budgeted INSIDE the 32 000-char text cap (the local store lets the mark
 * overflow it), because the wire schema's maxLength is the stored length.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AppendChatArgs,
  ChatAttachment,
  ChatMessage,
  LoadChatArgs,
  ProjectApi,
  RebindChatArgs,
  ResolveChatArgs,
  ResolveChatResult,
  ToolActivity,
} from './ipc.js'
import {
  ProjectStore,
  SCOPE_TEXT_MAX_CHARS,
  TEXT_MAX_CHARS,
  TEXT_TRUNCATED_MARK,
  TOOL_FIELD_MAX_CHARS,
} from './store.js'

// ────────────────────────────────────────────────────────────
// Wire shapes (mirror services/backend/src/storage/store.ts)
// ────────────────────────────────────────────────────────────

/** `GET /projects` item; also `GET/POST/PUT /projects…` without `files`. */
interface WireProjectInfo {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  version: number
}

/** `GET/POST/PUT /projects…` full record. */
interface WireProjectRecord extends WireProjectInfo {
  files: string[]
}

/** `GET/POST/PUT /projects/:projectId/chats…` full record. */
interface WireChatRecord {
  id: string
  projectId: string
  createdAt: string
  updatedAt: string
  version: number
  messageCount: number
  messages: ChatMessage[]
}

/** The uniform backend error envelope. */
interface WireErrorEnvelope {
  error: { code: string; message: string }
}

/** A message as accepted by the chat-replace endpoint (seq is server-assigned). */
type WireMessageInput = Omit<ChatMessage, 'seq' | 'ts'> & { ts?: string }

// ────────────────────────────────────────────────────────────
// Transport + errors
// ────────────────────────────────────────────────────────────

/**
 * Authenticated transport seam. The shell passes its backend client's
 * `fetch` (base URL + Bearer + refresh-once-on-401); tests pass a scripted
 * fake. Paths are relative (`/projects/…`), never absolute URLs.
 */
export type RemoteProjectTransport = (path: string, init?: RequestInit) => Promise<Response>

/** Stable error kind — the routing layer branches on it. */
export type RemoteProjectErrorCode = 'conflict' | 'unavailable' | 'http_error'

/** Base class: every failure of the remote adapter is one of these three. */
export class RemoteProjectError extends Error {
  readonly code: RemoteProjectErrorCode
  /** HTTP status when the server answered (`undefined` for transport failures). */
  readonly status: number | undefined

  constructor(message: string, options: { code: RemoteProjectErrorCode; status?: number }) {
    super(message)
    this.name = this.constructor.name
    this.code = options.code
    this.status = options.status
  }
}

/**
 * 409 `version_conflict`: another writer's version is stored, so this
 * client's read was stale. No merge happens; the caller re-reads and
 * decides (or surfaces the conflict).
 */
export class RemoteProjectConflictError extends RemoteProjectError {
  constructor(message = 'the chat changed on the server since it was read') {
    super(message, { code: 'conflict', status: 409 })
  }
}

/**
 * The backend could not be used: transport failure, 5xx, or a dead session
 * (a 401 that survived the transport's refresh-once). The shell's routing
 * layer answers this by serving the request from the local store.
 */
export class RemoteProjectUnavailableError extends RemoteProjectError {
  constructor(message = 'the cloud backend is unreachable', options?: { status?: number }) {
    super(message, { code: 'unavailable', status: options?.status })
  }
}

/** Any other definitive server rejection (400, 404, …) — surfaced, never a fallback. */
export class RemoteProjectApiError extends RemoteProjectError {
  constructor(message: string, options: { status: number }) {
    super(message, { code: 'http_error', status: options.status })
  }
}

// ────────────────────────────────────────────────────────────
// Caps (server validation limits, mirrored from the API schemas)
// ────────────────────────────────────────────────────────────

/** Server maxItems on the message array of a chat replace. */
const MAX_MESSAGES_PER_PUT = 10_000
/** Server maxItems on one message's tools array. */
const MAX_TOOLS_PER_MESSAGE = 200
/** Server maxItems on one message's attachments array. */
const MAX_ATTACHMENTS_PER_MESSAGE = 100

/**
 * The renderer-visible project id in remote mode. Every `ProjectApi` chat
 * lives in the account's server-side default project (the local store's
 * rule too); that project's server UUID is an internal detail held in the
 * index.
 */
const DEFAULT_PROJECT_ALIAS = 'default'
/** Server-side name of that project — the local store's default name. */
const DEFAULT_PROJECT_NAME = 'Default Project'

// ────────────────────────────────────────────────────────────
// Client-side index (the remote twin of the local index.json)
// ────────────────────────────────────────────────────────────

/** Which server chat UUID backs a renderer-visible chat id. */
interface RemoteChatEntry {
  projectId: string
  chatId: string
}

interface RemoteProjectIndex {
  version: 1
  /** id of the server-side default project (cached; revalidated on 404s) */
  defaultProjectId?: string
  /** renderer-visible chat id → server chat */
  chats: Record<string, RemoteChatEntry>
}

function emptyIndex(): RemoteProjectIndex {
  return { version: 1, chats: {} }
}

function readIndexFile(path: string): RemoteProjectIndex {
  try {
    if (!existsSync(path)) return emptyIndex()
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RemoteProjectIndex
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.chats === 'object') {
      return { version: 1, defaultProjectId: parsed.defaultProjectId, chats: parsed.chats }
    }
  } catch {
    // a corrupt index rebuilds itself: worst case a chat's history restarts
  }
  return emptyIndex()
}

/** Atomic write (tmp + rename), same discipline as the local store. */
function writeIndexFile(path: string, index: RemoteProjectIndex): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8')
  renameSync(tmpPath, path)
}

export interface RemoteProjectApiOptions {
  /** authenticated transport (the shell's backend client fetch) */
  transport: RemoteProjectTransport
  /** path of the client-side id index (created on first write) */
  indexPath: string
}

// ────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────

export class RemoteProjectApi implements ProjectApi {
  private readonly transport: RemoteProjectTransport
  private readonly indexPath: string
  private index: RemoteProjectIndex
  /**
   * One mutation queue: read-modify-write cycles never interleave inside
   * this process (a panel's user→assistant pair is two sequential PUTs).
   * Cross-device races still surface as conflicts — by design.
   */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: RemoteProjectApiOptions) {
    this.transport = options.transport
    this.indexPath = options.indexPath
    this.index = readIndexFile(options.indexPath)
  }

  /** Serializes mutations through the single queue. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    // whatever happens, later mutations still run
    this.queue = next.catch(() => undefined)
    return next
  }

  // ── transport helpers ─────────────────────────────────────

  private async request(
    method: string,
    path: string,
    body?: unknown,
    ifMatch?: number,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.transport(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(ifMatch === undefined ? {} : { 'if-match': String(ifMatch) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new RemoteProjectUnavailableError(
        `request to the cloud backend failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status === 409) throw new RemoteProjectConflictError()
    if (response.status === 401) {
      // the transport already refreshed once; a second 401 is a dead session
      throw new RemoteProjectUnavailableError('the cloud session is no longer valid', {
        status: 401,
      })
    }
    if (response.status >= 500) {
      throw new RemoteProjectUnavailableError(`the cloud backend answered ${response.status}`, {
        status: response.status,
      })
    }
    if (!response.ok) {
      // the envelope's stable code (not_found, validation_failed, …) makes
      // the rejection diagnosable in main-process logs
      let code = ''
      try {
        const envelope = (await response.json()) as Partial<WireErrorEnvelope>
        if (envelope && typeof envelope.error === 'object') code = envelope.error.code ?? ''
      } catch {
        // an unreadable body still classifies by status alone
      }
      throw new RemoteProjectApiError(
        `the cloud backend rejected the request${code ? ` (${code})` : ''}`,
        { status: response.status },
      )
    }
    return response
  }

  private async json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T
    } catch (error) {
      throw new RemoteProjectUnavailableError(
        `the cloud backend sent an unreadable body: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // ── server resources ──────────────────────────────────────

  /** The account's server-side default project, found by name or created. */
  private async ensureDefaultProject(): Promise<string> {
    const cached = this.index.defaultProjectId
    if (cached !== undefined) {
      try {
        const project = await this.json<WireProjectRecord>(
          await this.request('GET', `/projects/${cached}`),
        )
        return project.id
      } catch (error) {
        if (!(error instanceof RemoteProjectApiError) || error.status !== 404) throw error
        // deleted server-side (or a stale index): re-resolve below
      }
    }
    const list = await this.json<{ projects: WireProjectInfo[] }>(
      await this.request('GET', '/projects'),
    )
    const existing = list.projects.find((p) => p.name === DEFAULT_PROJECT_NAME)
    const id =
      existing?.id ??
      (
        await this.json<WireProjectRecord>(
          await this.request('POST', '/projects', { name: DEFAULT_PROJECT_NAME }),
        )
      ).id
    this.index.defaultProjectId = id
    this.saveIndex()
    return id
  }

  /** Creates an empty chat row under the given project. */
  private async createChat(projectId: string): Promise<WireChatRecord> {
    return this.json<WireChatRecord>(await this.request('POST', `/projects/${projectId}/chats`))
  }

  /** Full chat (messages + version); null when the server answers 404. */
  private async getChat(
    projectId: string,
    chatId: string,
    limit?: number,
  ): Promise<WireChatRecord | null> {
    try {
      const query = limit === undefined ? '' : `?limit=${limit}`
      return await this.json<WireChatRecord>(
        await this.request('GET', `/projects/${projectId}/chats/${chatId}${query}`),
      )
    } catch (error) {
      if (error instanceof RemoteProjectApiError && error.status === 404) return null
      throw error
    }
  }

  /** Full message replace, guarded by the version the caller read. */
  private async putChat(
    projectId: string,
    chatId: string,
    messages: WireMessageInput[],
    expectedVersion: number,
  ): Promise<WireChatRecord> {
    return this.json<WireChatRecord>(
      await this.request(
        'PUT',
        `/projects/${projectId}/chats/${chatId}`,
        { messages },
        expectedVersion,
      ),
    )
  }

  private async deleteChat(
    projectId: string,
    chatId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/projects/${projectId}/chats/${chatId}`,
      undefined,
      expectedVersion,
    )
  }

  private saveIndex(): void {
    try {
      writeIndexFile(this.indexPath, this.index)
    } catch (error) {
      // a failed index write must not lose the just-recorded mapping in memory
      console.warn('[project-store] writing the remote index failed:', error)
    }
  }

  /** The server chat behind a renderer-visible id, or undefined. */
  private entryFor(chatId: string): RemoteChatEntry | undefined {
    return this.index.chats[chatId]
  }

  /**
   * The server chat behind a renderer-visible id, creating it (and the
   * default project when needed) on first use.
   */
  private async ensureEntry(chatId: string): Promise<RemoteChatEntry> {
    const existing = this.entryFor(chatId)
    if (existing !== undefined) return existing
    const projectId = await this.ensureDefaultProject()
    const chat = await this.createChat(projectId)
    const entry = { projectId, chatId: chat.id }
    this.index.chats[chatId] = entry
    this.saveIndex()
    return entry
  }

  /** Drops an id mapping (persisting the index) — used after rebinds. */
  private dropEntry(chatId: string): void {
    delete this.index.chats[chatId]
    this.saveIndex()
  }

  /**
   * The server chat behind an id together with its current record,
   * (re)creating the row when there is no mapping yet or the mapped row
   * vanished server-side (project deleted, data reset) — a fresh row beats
   * failing every future operation on that id.
   */
  private async ensureReadableEntry(
    chatId: string,
  ): Promise<{ entry: RemoteChatEntry; chat: WireChatRecord }> {
    const mapped = this.entryFor(chatId)
    if (mapped !== undefined) {
      const chat = await this.getChat(mapped.projectId, mapped.chatId)
      if (chat !== null) return { entry: mapped, chat }
      delete this.index.chats[chatId]
    }
    const entry = await this.ensureEntry(chatId)
    const chat = await this.getChat(entry.projectId, entry.chatId)
    if (chat === null) {
      throw new RemoteProjectUnavailableError('a freshly created chat is not readable')
    }
    return { entry, chat }
  }

  // ── ProjectApi ────────────────────────────────────────────

  async resolveChat(args: ResolveChatArgs): Promise<ResolveChatResult> {
    if (!args.filePath) {
      // unsaved file: default project + the renderer's temp id (local rule)
      return {
        projectId: DEFAULT_PROJECT_ALIAS,
        chatId: args.tempChatId ?? `unsaved-${Date.now()}`,
      }
    }
    // same derivation as the local store, so the id is stable in both modes
    return { projectId: DEFAULT_PROJECT_ALIAS, chatId: ProjectStore.chatIdForFile(args.filePath) }
  }

  async appendChat(args: AppendChatArgs): Promise<void> {
    await this.enqueue(async () => {
      const { entry, chat } = await this.ensureReadableEntry(args.chatId)
      const messages: WireMessageInput[] = [
        ...chat.messages.map(({ seq: _seq, ...message }) => message),
        toWireMessage(args),
      ].slice(-MAX_MESSAGES_PER_PUT)
      await this.putChat(entry.projectId, entry.chatId, messages, chat.version)
    })
  }

  async loadChat(args: LoadChatArgs): Promise<ChatMessage[]> {
    const entry = this.entryFor(args.chatId)
    if (entry === undefined) return [] // never mapped → no history to read
    const chat = await this.getChat(entry.projectId, entry.chatId, args.limit)
    return chat?.messages ?? []
  }

  async rebindChat(args: RebindChatArgs): Promise<ResolveChatResult> {
    const targetChatId = args.newFilePath
      ? ProjectStore.chatIdForFile(args.newFilePath)
      : (args.newChatId ?? args.tempChatId)
    const result: ResolveChatResult = { projectId: DEFAULT_PROJECT_ALIAS, chatId: targetChatId }
    if (targetChatId === args.tempChatId) return result // nothing to move

    await this.enqueue(async () => {
      const source = this.entryFor(args.tempChatId)
      if (source === undefined) return // nothing buffered remotely: no-op
      const sourceChat = await this.getChat(source.projectId, source.chatId)
      const moved = sourceChat?.messages ?? []
      if (moved.length === 0) {
        this.dropEntry(args.tempChatId)
        return
      }
      const { entry: target, chat: targetChat } = await this.ensureReadableEntry(targetChatId)
      // local merge semantics: the target's existing history stays, the
      // moved messages follow it (the server renumbers seq 1..n; `seq` is
      // server-assigned, so neither side re-uploads one)
      const merged: WireMessageInput[] = [
        ...targetChat.messages.map(({ seq: _targetSeq, ...message }) => message),
        ...moved.map(({ seq: _seq, ...message }) => message),
      ].slice(-MAX_MESSAGES_PER_PUT)
      await this.putChat(target.projectId, target.chatId, merged, targetChat.version)
      this.dropEntry(args.tempChatId)
      // the copy landed; removing the source row is best-effort (a 409/404
      // here only leaves a duplicate row behind, it never loses messages)
      if (sourceChat !== null) {
        try {
          await this.deleteChat(source.projectId, source.chatId, sourceChat.version)
        } catch (error) {
          console.warn('[project-store] deleting the rebound source chat failed:', error)
        }
      }
    })
    return result
  }
}

// ────────────────────────────────────────────────────────────
// Upload shaping (local truncation constants, applied pre-upload)
// ────────────────────────────────────────────────────────────

function truncateText(text: string): string {
  if (text.length <= TEXT_MAX_CHARS) return text
  // the mark is budgeted inside the cap: the API's maxLength is the stored
  // length (the local store lets the mark overflow it)
  return text.slice(0, TEXT_MAX_CHARS - TEXT_TRUNCATED_MARK.length) + TEXT_TRUNCATED_MARK
}

function truncateTools(tools: ToolActivity[]): ToolActivity[] {
  return tools.slice(0, MAX_TOOLS_PER_MESSAGE).map((tool) => ({
    ...tool,
    ...(tool.input !== undefined ? { input: tool.input.slice(0, TOOL_FIELD_MAX_CHARS) } : {}),
    ...(tool.output !== undefined ? { output: tool.output.slice(0, TOOL_FIELD_MAX_CHARS) } : {}),
  }))
}

function truncateAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
}

/** One renderer append as a chat-replace body item (seq stays server-side). */
function toWireMessage(args: AppendChatArgs): WireMessageInput {
  const message: WireMessageInput = { role: args.role, text: truncateText(args.text) }
  if (args.tools !== undefined && args.tools.length > 0) {
    message.tools = truncateTools(args.tools)
  }
  if (args.attachments !== undefined && args.attachments.length > 0) {
    message.attachments = truncateAttachments(args.attachments)
  }
  if (args.scope !== undefined) {
    message.scope = {
      label: args.scope.label,
      ...(args.scope.text !== undefined
        ? { text: args.scope.text.slice(0, SCOPE_TEXT_MAX_CHARS) }
        : {}),
    }
  }
  return message
}
