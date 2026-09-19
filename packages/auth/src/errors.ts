/**
 * Typed error surface for the auth package.
 * No stringly-typed throws: every failure is an Error subclass carrying a
 * stable machine-readable `code` and, when the server answered, its HTTP
 * `status`. Later modules (token poller, store, orchestrator) extend
 * `AuthError` the same way.
 */

export type DiscoveryErrorCode = 'http_error' | 'network_error' | 'invalid_document'

export type DeviceAuthErrorCode = 'http_error' | 'network_error' | 'invalid_response'

export type TokenSetErrorCode =
  'invalid_response' | 'invalid_jwt' | 'iss_mismatch' | 'aud_mismatch' | 'missing_sub'

export type TokenPollErrorCode =
  | 'access_denied'
  | 'expired_token'
  | 'poll_expired'
  | 'cancelled'
  | 'http_error'
  | 'network_error'
  | 'invalid_response'

export type TokenStoreErrorCode = 'io_error' | 'corrupt_file'

export type AuthFlowErrorCode =
  | 'cancelled'
  | 'not_logged_in'
  | 'refresh_failed'
  | 'http_error'
  | 'network_error'
  | 'invalid_response'
  | 'missing_endpoint'
  | 'invalid_url'

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

export class TokenSetError extends AuthError<TokenSetErrorCode> {}

export class TokenPollError extends AuthError<TokenPollErrorCode> {}

export class TokenStoreError extends AuthError<TokenStoreErrorCode> {}

export class AuthFlowError extends AuthError<AuthFlowErrorCode> {}
