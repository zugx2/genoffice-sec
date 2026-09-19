/**
 * @genoffice/auth public surface.
 * Later modules (token-poller, token-set, token-store, auth orchestrator)
 * append their re-exports here without renaming anything below.
 */

export { DiscoveryClient, parseDiscoveryDocument } from './discovery.js'
export { requestDeviceAuthorization } from './device-auth.js'
export { AuthError, DeviceAuthError, DiscoveryError } from './errors.js'
export type { DeviceAuthErrorCode, DiscoveryErrorCode } from './errors.js'
export type {
  Clock,
  DeviceAuthorizationRequest,
  DeviceAuthorizationResponse,
  DiscoveryClientOptions,
  DiscoveryDocument,
  FetchLike,
} from './types.js'
