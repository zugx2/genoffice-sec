/**
 * `/projects` — project CRUD, scoped to the verified `sub`.
 *
 * Mirrors `packages/project-store`'s project model: a project is a name plus
 * a list of file paths (`ProjectData`); the list endpoint returns the light
 * `ProjectInfo` shape (no files), get/update return the full record. Create
 * takes just a name (files start empty, as with the local store's
 * `createProject`); update is a full-object replace (PUT) that bumps
 * `version` + `updatedAt`; delete is a hard delete that also removes the
 * project's chats (see `BackendStore.deleteProject`).
 *
 * Missing and foreign ids answer the same 404 — no existence leak.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { notFound, versionConflict } from '../errors.js'
import type { ProjectRecord } from '../storage/store.js'
import { ifMatchVersion } from './if-match.js'
import { requireSub } from './sub.js'

/** Project as returned by GET/PUT (full record, `ProjectData` + version). */
export type ProjectResponseBody = ProjectRecord

/** Light shape for list items (`ProjectInfo` + version; no files). */
export type ProjectInfoBody = Omit<ProjectResponseBody, 'files'>

function toInfo(project: ProjectRecord): ProjectInfoBody {
  const { files: _files, ...info } = project
  return info
}

// ── JSON schemas (fastify's built-in ajv validation; no extra deps) ──

const projectNameSchema = {
  // at least one non-whitespace char; the handler trims before storing
  type: 'string',
  pattern: '\\S',
  maxLength: 200,
} as const

const projectFilesSchema = {
  type: 'array',
  maxItems: 10_000,
  items: { type: 'string', maxLength: 2048 },
} as const

const idParamSchema = {
  type: 'object',
  required: ['projectId'],
  additionalProperties: false,
  properties: { projectId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const

export const projectRoutes: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  app.get('/projects', { preHandler: [app.authenticate] }, async (request) => {
    const sub = requireSub(request)
    return { projects: app.store.listProjects(sub).map(toInfo) }
  })

  app.post(
    '/projects',
    {
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: projectNameSchema },
        },
      },
    },
    async (request, reply) => {
      const sub = requireSub(request)
      const body = request.body as { name: string }
      const project = app.store.createProject(sub, body.name.trim())
      return reply.code(201).send(project)
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId',
    { preHandler: [app.authenticate], schema: { params: idParamSchema } },
    async (request) => {
      const sub = requireSub(request)
      const project = app.store.getProject(sub, request.params.projectId)
      if (project === null) throw notFound()
      return project
    },
  )

  app.put<{ Params: { projectId: string } }>(
    '/projects/:projectId',
    {
      preHandler: [app.authenticate],
      schema: {
        params: idParamSchema,
        body: {
          type: 'object',
          required: ['name', 'files'],
          additionalProperties: false,
          properties: { name: projectNameSchema, files: projectFilesSchema },
        },
      },
    },
    async (request) => {
      const sub = requireSub(request)
      const expected = ifMatchVersion(request)
      if (expected !== undefined) {
        // guard before mutating: an older read than the stored version is a
        // 409 (missing/foreign still 404s via the update below)
        const current = app.store.getProject(sub, request.params.projectId)
        if (current !== null && current.version !== expected) throw versionConflict()
      }
      const body = request.body as { name: string; files: string[] }
      const project = app.store.updateProject(
        sub,
        request.params.projectId,
        body.name.trim(),
        body.files,
      )
      if (project === null) throw notFound()
      return project
    },
  )

  app.delete<{ Params: { projectId: string } }>(
    '/projects/:projectId',
    { preHandler: [app.authenticate], schema: { params: idParamSchema } },
    async (request, reply) => {
      const sub = requireSub(request)
      const expected = ifMatchVersion(request)
      if (expected !== undefined) {
        const current = app.store.getProject(sub, request.params.projectId)
        if (current !== null && current.version !== expected) throw versionConflict()
      }
      if (!app.store.deleteProject(sub, request.params.projectId)) throw notFound()
      return reply.code(204).send()
    },
  )
}
