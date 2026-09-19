/**
 * @genoffice/auth public surface.
 * Later modules (token-poller, token-set, token-store, auth orchestrator)
 * append their re-exports here without renaming anything below.
 */

export { DiscoveryClient, parseDiscoveryDocument } from './discovery.js'
export { requestDeviceAuthorization } from './device-auth.js'
export { startDeviceTokenPoll } from './token-poller.js'
export { decodeJwt, isJwtExpired, parseTokenResponse, validateIdToken } from './token-set.js'
export {
  AuthError,
  DeviceAuthError,
  DiscoveryError,
  TokenPollError,
  TokenSetError,
} from './errors.js'
export type {
  DeviceAuthErrorCode,
  DiscoveryErrorCode,
  TokenPollErrorCode,
  TokenSetErrorCode,
} from './errors.js'
export type {
  Clock,
  DecodedJwt,
  DeviceAuthorizationRequest,
  DeviceAuthorizationResponse,
  DeviceTokenPollHandle,
  DeviceTokenPollOptions,
  DiscoveryClientOptions,
  DiscoveryDocument,
  FetchLike,
  IdTokenClaims,
  IdTokenValidationOptions,
  JwtExpiryOptions,
  Sleep,
  TokenSet,
} from './types.js'
