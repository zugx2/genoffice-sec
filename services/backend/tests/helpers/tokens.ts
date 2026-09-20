/**
 * Test helper: mint real RS256-signed access tokens with `SignJWT`, so the
 * suite verifies actual signatures (and actual signature failures), never
 * mocked verify results.
 */

import { SignJWT } from 'jose'
import type { KeyObject } from 'node:crypto'

export interface SignAccessTokenOptions {
  iss: string
  aud: string | string[]
  sub: string
  /** Epoch seconds; default `now + 300` */
  exp?: number
  /** Epoch seconds; default `now - 10` */
  iat?: number
  realmAccessRoles?: string[]
  scope?: string
}

/** Sign a Keycloak-shaped access token with the given key under the given `kid` header. */
export async function signAccessToken(
  privateKey: KeyObject,
  kid: string,
  claims: SignAccessTokenOptions,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return await new SignJWT({
    ...(claims.realmAccessRoles ? { realm_access: { roles: claims.realmAccessRoles } } : {}),
    ...(claims.scope !== undefined ? { scope: claims.scope } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt(claims.iat ?? nowSeconds - 10)
    .setExpirationTime(claims.exp ?? nowSeconds + 300)
    .sign(privateKey)
}
