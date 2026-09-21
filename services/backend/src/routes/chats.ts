/**
 * `/projects/:projectId/chats` — chat CRUD nested under a project, scoped
 * to the verified `sub`.
 *
 * Mirrors `packages/project-store`'s chat model: a chat belongs to exactly
 * one project and is an ordered message list (the local store's JSONL file;
 * `seq` is store-assigned and monotonic). Create makes an empty chat; update
 * (PUT) fully replaces the message list — the server assigns `seq` (1..n by
 * position) and `ts` (client value or now) — and bumps `version` +
 * `updatedAt`; get returns the messages ascending by seq, optionally just
 * the most recent `?limit=N` (same semantics as the local `loadChat`);
 * delete is a hard delete.
 *
 * The nesting is ownership-checked: a chat under a foreign/missing project,
 * or a chat id from another project, answers the same 404 as anything
 * missing — no existence leak.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { notFound, versionConflict } from '../errors.js'
import type { ChatMessageInput, ChatRecord, ChatSummaryRecord } from '../storage/store.js'
import { ifMatchVersion } from './if-match.js'
import { requireSub } from './sub.js'

/** Chat as returned by GET/PUT/POST (summary + messages). */
export type ChatResponseBody = ChatRecord

/** Light shape for list items (the local `ChatMeta` + version). */
export type ChatSummaryBody = ChatSummaryRecord

// ── JSON schemas (fastify's built-in ajv validation; no extra deps) ──

const projectIdParamSchema = {
  type: 'object',
  required: ['projectId'],
  additionalProperties: false,
  properties: { projectId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const

const chatParamsSchema = {
  type: 'object',
  required: ['projectId', 'chatId'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
    chatId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

// Field length caps mirror packages/project-store's truncation limits
// (TEXT_MAX_CHARS / TOOL_FIELD_MAX_CHARS / SCOPE_TEXT_MAX_CHARS). The local
// store truncates silently; the API rejects, so clients apply the same
// truncation before uploading.
const toolActivitySchema = {
  type: 'object',
  required: ['name', 'summary'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    summary: { type: 'string', maxLength: 2000 },
    isError: { type: 'boolean' },
    input: { type: 'string', maxLength: 16_000 },
    output: { type: 'string', maxLength: 16_000 },
  },
} as const

const attachmentSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 512 },
    path: { type: 'string', maxLength: 2048 },
    ext: { type: 'string', maxLength: 32 },
    sizeBytes: { type: 'integer', minimum: 0 },
  },
} as const

const messageSchema = {
  type: 'object',
  required: ['role', 'text'],
  additionalProperties: false,
  properties: {
    role: { enum: ['user', 'assistant'] },
    text: { type: 'string', maxLength: 32_000 },
    // optional client-side timestamp (UTC ISO); the server defaults it
    ts: { type: 'string', maxLength: 40 },
    fileRef: { type: 'string', maxLength: 2048 },
    tools: { type: 'array', maxItems: 200, items: toolActivitySchema },
    attachments: { type: 'array', maxItems: 100, items: attachmentSchema },
    scope: {
      type: 'object',
      required: ['label'],
      additionalProperties: false,
      properties: {
        label: { type: 'string', maxLength: 512 },
        text: { type: 'string', maxLength: 400 },
      },
    },
  },
} as const

const messagesBodySchema = {
  type: 'object',
  required: ['messages'],
  additionalProperties: false,
  properties: {
    messages: { type: 'array', maxItems: 10_000, items: messageSchema },
  },
} as const

export const chatRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/chats',
    { preHandler: [app.authenticate], schema: { params: projectIdParamSchema } },
    async (request) => {
      const sub = requireSub(request)
      const chats = app.store.listChats(sub, request.params.projectId)
      if (chats === null) throw notFound()
      return { chats }
    },
  )

  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/chats',
    { preHandler: [app.authenticate], schema: { params: projectIdParamSchema } },
    async (request, reply) => {
      const sub = requireSub(request)
      const chat = app.store.createChat(sub, request.params.projectId)
      if (chat === null) throw notFound()
      return reply.code(201).send(chat)
    },
  )

  app.get<{ Params: { projectId: string; chatId: string } }>(
    '/projects/:projectId/chats/:chatId',
    {
      preHandler: [app.authenticate],
      schema: {
        params: chatParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          // Query strings are not type-coerced (see buildApp ajv options);
          // 1–6 digits keeps the parsed value within the 100 000 cap below.
          properties: { limit: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' } },
        },
      },
    },
    async (request) => {
      const sub = requireSub(request)
      const query = request.query as { limit?: string }
      const limit = query.limit === undefined ? undefined : Math.min(Number(query.limit), 100_000)
      const chat = app.store.getChat(sub, request.params.projectId, request.params.chatId, limit)
      if (chat === null) throw notFound()
      return chat
    },
  )

  app.put<{ Params: { projectId: string; chatId: string } }>(
    '/projects/:projectId/chats/:chatId',
    {
      preHandler: [app.authenticate],
      schema: { params: chatParamsSchema, body: messagesBodySchema },
    },
    async (request) => {
      const sub = requireSub(request)
      const expected = ifMatchVersion(request)
      if (expected !== undefined) {
        // guard before mutating: an older read than the stored version is a
        // 409 (missing/foreign still 404s via the replace below)
        const current = app.store.chatVersion(sub, request.params.projectId, request.params.chatId)
        if (current !== null && current !== expected) throw versionConflict()
      }
      const body = request.body as { messages: ChatMessageInput[] }
      const chat = app.store.updateChat(
        sub,
        request.params.projectId,
        request.params.chatId,
        body.messages,
      )
      if (chat === null) throw notFound()
      return chat
    },
  )

  app.delete<{ Params: { projectId: string; chatId: string } }>(
    '/projects/:projectId/chats/:chatId',
    { preHandler: [app.authenticate], schema: { params: chatParamsSchema } },
    async (request, reply) => {
      const sub = requireSub(request)
      const expected = ifMatchVersion(request)
      if (expected !== undefined) {
        const current = app.store.chatVersion(sub, request.params.projectId, request.params.chatId)
        if (current !== null && current !== expected) throw versionConflict()
      }
      if (!app.store.deleteChat(sub, request.params.projectId, request.params.chatId)) {
        throw notFound()
      }
      return reply.code(204).send()
    },
  )
}
