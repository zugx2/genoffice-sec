/**
 * @genoffice/auth public surface.
 * Later modules append their re-exports here without renaming anything below.
 */

export { DiscoveryClient, parseDiscoveryDocument } from './discovery.js'
export { requestDeviceAuthorization } from './device-auth.js'
export { startDeviceTokenPoll } from './token-poller.js'
export { decodeJwt, isJwtExpired, parseTokenResponse, validateIdToken } from './token-set.js'
export { FileTokenStore } from './token-store.js'
export { AuthOrchestrator } from './auth.js'
export {
  AuthError,
  AuthFlowError,
  DeviceAuthError,
  DiscoveryError,
  TokenPollError,
  TokenSetError,
  TokenStoreError,
} from './errors.js'
export type {
  AuthFlowErrorCode,
  DeviceAuthErrorCode,
  DiscoveryErrorCode,
  TokenPollErrorCode,
  TokenSetErrorCode,
  TokenStoreErrorCode,
} from './errors.js'
export type {
  AuthConfig,
  AuthOrchestratorOptions,
  AuthSession,
  Clock,
  DecodedJwt,
  DeviceAuthorizationRequest,
  DeviceAuthorizationResponse,
  DeviceTokenPollHandle,
  DeviceTokenPollOptions,
  DiscoveryClientOptions,
  DiscoveryDocument,
  FetchLike,
  FileTokenStoreOptions,
  IdTokenClaims,
  IdTokenValidationOptions,
  JwtExpiryOptions,
  LoginHandle,
  LogoutResult,
  Sleep,
  StoredTokenSet,
  TokenSet,
  TokenStore,
  UserProfile,
} from './types.js'
