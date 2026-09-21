/**
 * `If-Match` version guard (Phase 6b conflict policy).
 *
 * PUT/DELETE accept an optional `If-Match: <version>` header — the bare
 * integer `version` the client last saw (records carry a monotonic
 * `version`; there is no ETag). When present, the handler compares it with
 * the stored version BEFORE mutating:
 *
 * - match (or header absent) → the mutation runs (absent = plain
 *   last-writer-wins, the Phase 6a behavior);
 * - older version → 409 `version_conflict` (another writer got there
 *   first; the client re-reads and decides — no server-side merge);
 * - anything but a bare non-negative integer (`"3"`, `*`, a list) → 400
 *   `validation_failed`, in line with the API's strict-validation stance.
 *
 * A missing/foreign resource still answers 404 — the guard never turns a
 * missing record into a conflict, and never leaks its existence.
 */

import type { FastifyRequest } from 'fastify'
import { badIfMatch } from '../errors.js'

/** Parses `If-Match` into the expected version; undefined when absent. */
export function ifMatchVersion(request: FastifyRequest): number | undefined {
  const header = request.headers['if-match']
  if (header === undefined) return undefined
  if (!/^\d+$/.test(header)) throw badIfMatch()
  return Number(header)
}
