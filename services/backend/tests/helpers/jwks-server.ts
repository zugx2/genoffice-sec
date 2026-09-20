/**
 * Test helper: a local JWKS endpoint backed by real, locally generated
 * RSA keys, served over real HTTP on an ephemeral port. `jose`'s
 * `createRemoteJWKSet` fetches from it exactly as it would from Keycloak,
 * so the unit suite exercises real signatures, real JWKS caching, and real
 * unknown-`kid` rotation — no mocked verify results.
 */

import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { exportJWK } from 'jose'

export interface TestKey {
  kid: string
  /** JWK shape of the public key (kty/n/e), as a JWKS entry carries it */
  publicJwk: Record<string, unknown>
  /** Signing key (KeyObject accepted by `SignJWT`) */
  privateKey: KeyObject
}

/** Generate a fresh RSA key pair with a `kid`, as a realm rotation would. */
export async function generateTestKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { kid, publicJwk: await exportJWK(publicKey), privateKey }
}

/**
 * HTTP server answering `GET <origin>/jwks` with the currently installed
 * key set. `setKeys` swaps the served set atomically — the rotation test
 * uses it to simulate Keycloak publishing a new key after the plugin has
 * already cached the old one.
 */
export class JwksTestServer {
  readonly #server: Server
  #keys: TestKey[] = []
  #fetchCount = 0

  private constructor(server: Server) {
    this.#server = server
    this.#server.on('request', (req, res) => {
      if (req.method !== 'GET' || req.url !== '/jwks') {
        res.statusCode = 404
        res.end()
        return
      }
      this.#fetchCount += 1
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          keys: this.#keys.map((key) => ({
            ...key.publicJwk,
            kid: key.kid,
            use: 'sig',
            alg: 'RS256',
          })),
        }),
      )
    })
  }

  static async start(): Promise<JwksTestServer> {
    const instance = new JwksTestServer(
      createServer({
        // Keycloak answers JWKS requests without a body; keep keep-alive off
        // so jose's fetches behave like fresh ones.
        keepAlive: false,
      }),
    )
    await new Promise<void>((resolve, reject) => {
      instance.#server.once('error', reject)
      instance.#server.listen(0, '127.0.0.1', () => resolve())
    })
    return instance
  }

  /** The JWKS URL `createRemoteJWKSet` should point at. */
  get url(): string {
    const address = this.#server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('JWKS test server has no address')
    }
    return `http://127.0.0.1:${address.port}/jwks`
  }

  /** How many times the JWKS endpoint has been fetched. */
  get fetchCount(): number {
    return this.#fetchCount
  }

  /** Atomically swap the served key set (simulates a realm rotation). */
  setKeys(keys: TestKey[]): void {
    this.#keys = keys
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}
