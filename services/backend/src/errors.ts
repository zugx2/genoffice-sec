/**
 * Typed API errors.
 *
 * Route handlers throw these; the global error handler
 * (`plugins/error-handler.ts`) turns them into the uniform
 * `{error: {code, message}}` envelope. A 404 thrown here is deliberately
 * message-identical for "does not exist" and "belongs to another user" so
 * foreign ids leak no existence information.
 */

export class ApiError extends Error {
  constructor(
    /** HTTP status code */
    readonly statusCode: number,
    /** Stable machine-readable code for the error envelope */
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 404 used for every missing OR foreign resource (indistinguishable). */
export function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'resource not found')
}
