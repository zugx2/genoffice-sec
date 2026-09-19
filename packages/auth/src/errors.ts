/**
 * Typed error surface for the auth package.
 * No stringly-typed throws: every failure is an Error subclass carrying a
 * stable machine-readable `code` and, when the server answered, its HTTP
 * `status`. Later modules (token poller, store, orchestrator) extend
 * `AuthError` the same way.
 */

export type DiscoveryErrorCode = 'http_error' | 'network_error' | 'invalid_document'

export type DeviceAuthErrorCode = 'http_error' | 'network_error' | 'invalid_response'

export interface AuthErrorOptions<C extends string> {
  code: C
  /** HTTP status when the server answered */
  status?: number
  /** Underlying transport/parse failure */
  cause?: unknown
}

export class AuthError<C extends string = string> extends Error {
  readonly code: C
  readonly status?: number

  constructor(message: string, options: AuthErrorOptions<C>) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = this.constructor.name
    this.code = options.code
    this.status = options.status
  }
}

export class DiscoveryError extends AuthError<DiscoveryErrorCode> {}

export class DeviceAuthError extends AuthError<DeviceAuthErrorCode> {}
