/**
 * Global error handler — the uniform error envelope (Phase 3 carry-over,
 * folded in with Phase 6 as planned).
 *
 * EVERY error response from this service has the shape
 * `{error: {code, message}}`:
 * - route/handler `ApiError`s keep their own status + code;
 * - schema-validation failures (fastify/ajv) answer 400 `validation_failed`
 *   with the validator's message (request-derived, safe to expose);
 * - other fastify 4xx errors (malformed JSON body, unsupported media type…)
 *   keep their status under code `bad_request`;
 * - anything else is logged server-side and answered 500 `internal_error`
 *   with a generic message — internals never leak.
 *
 * The 401/500 bodies produced by `verifyAuth` already use this envelope and
 * are sent directly by the plugin (not thrown), so they are unaffected.
 */

import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { ApiError } from '../errors.js'

interface ErrorBody {
  error: { code: string; message: string }
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } }
}

/** A status fastify would never set on a real error (unset/2xx/3xx). */
function replyStatus(err: FastifyError): number | undefined {
  const status = err.statusCode
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : undefined
}

export const errorHandlerPlugin = fp(
  async (app: FastifyInstance): Promise<void> => {
    app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      if (err.validation !== undefined) {
        // JSON-schema rejection: the message names the offending request part.
        void reply.code(400).send(errorBody('validation_failed', err.message))
        return
      }
      if (err instanceof ApiError) {
        void reply.code(err.statusCode).send(errorBody(err.code, err.message))
        return
      }
      const status = replyStatus(err)
      if (status !== undefined && status < 500) {
        // Fastify-level client errors (invalid JSON body, 413, 415, …).
        void reply.code(status).send(errorBody('bad_request', err.message))
        return
      }
      request.log.error(
        { err: { message: err.message, stack: err.stack } },
        'unhandled error while serving request',
      )
      void reply.code(500).send(errorBody('internal_error', 'internal server error'))
    })

    // Unknown routes/methods get the same envelope.
    app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
      void reply.code(404).send(errorBody('not_found', 'route not found'))
    })
  },
  { name: 'errorHandler' },
)
