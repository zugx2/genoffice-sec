/**
 * Integration check for the Phase 4 backend skeleton against the live
 * Phase 0 Keycloak stack (docs/cloud-backend-auth.md).
 *
 * 1. boot check: probes Keycloak discovery; if it is down, boots the
 *    docker/keycloak compose stack via `sg docker -c` (this environment
 *    reaches docker only through sg).
 * 2. mints a REAL access token through the device flow, approving it
 *    programmatically as testuser via the verification page (cookie-jar
 *    form POSTs — approach adapted from the controller's smoke
 *    run1-login.mts, copied here so the script is self-contained).
 * 3. starts the backend in-process (buildApp + listen, ephemeral port).
 * 4. asserts GET /whoami: no token → 401 + WWW-Authenticate; with the
 *    minted token → 200 and the identity matches the token's sub.
 * 5. cleanup: closes the backend. Keycloak is left as found (the operator
 *    tears it down with `docker compose ... down -v`).
 *
 * Run: npm run -w @genoffice/backend test:integration
 * Never part of plain `npm test`.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildApp, loadConfig } from '../src/index.js'

const ISSUER = 'http://localhost:8080/realms/genoffice'
const CLIENT_ID = 'genoffice-desktop'
const SCOPE = 'openid profile email'
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const COMPOSE_FILE = join(REPO_ROOT, 'docker', 'keycloak', 'docker-compose.yml')

const log = (msg: string): void => console.log(`[integration] ${msg}`)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ─── Keycloak boot check ───────────────────────────────────────────────

async function discoveryUp(): Promise<boolean> {
  try {
    const res = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureKeycloak(): Promise<void> {
  if (await discoveryUp()) {
    log('keycloak already up')
    return
  }
  log('keycloak down — booting docker/keycloak compose stack (first boot takes ~30 s)')
  const up = spawnSync('sg', ['docker', '-c', `docker compose -f "${COMPOSE_FILE}" up -d --wait`], {
    stdio: 'inherit',
  })
  if (up.status !== 0) throw new Error(`docker compose up failed (exit ${up.status ?? 'null'})`)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await discoveryUp()) {
      log('keycloak is up')
      return
    }
    await sleep(2000)
  }
  throw new Error('keycloak discovery did not come up within 90 s')
}

// ─── Device flow: authorize + approve as testuser ──────────────────────

interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  interval: number
}

async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/auth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  })
  if (!res.ok) throw new Error(`device authorization failed: HTTP ${res.status}`)
  const doc = (await res.json()) as Record<string, string>
  return {
    deviceCode: doc.device_code,
    userCode: doc.user_code,
    verificationUri: doc.verification_uri,
    verificationUriComplete: doc.verification_uri_complete,
    interval: doc.interval ? Number(doc.interval) : 5,
  }
}

// Cookie-jar browser session for the scripted approval (copied from the
// controller's smoke script; form POSTs exactly as a browser would).
const jar = new Map<string, string>()
function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}
function absorbCookies(res: Response): void {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}
async function getPage(url: string): Promise<Response> {
  const res = await fetch(url, { redirect: 'manual', headers: { cookie: cookieHeader() } })
  absorbCookies(res)
  return res
}
async function getFollowing(url: string, hops = 8): Promise<string> {
  let current = url
  for (let i = 0; i < hops; i++) {
    const res = await getPage(current)
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return await res.text()
      current = new URL(loc, current).toString()
      continue
    }
    return await res.text()
  }
  throw new Error(`too many redirects at ${current}`)
}
async function postForm(
  url: string,
  data: Record<string, string>,
): Promise<{ status: number; location: string | null; body: string }> {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
  })
  absorbCookies(res)
  return { status: res.status, location: res.headers.get('location'), body: await res.text() }
}
function formAction(html: string): string {
  const m = html.match(/action="([^"]+)"/)
  if (!m) throw new Error(`no form action in: ${html.slice(0, 300)}`)
  return m[1].replaceAll('&amp;', '&')
}
function hiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = m[0].match(/name="([^"]+)"/)?.[1]
    const value = m[0].match(/value="([^"]*)"/)?.[1] ?? ''
    if (name) out[name] = value.replaceAll('&amp;', '&')
  }
  return out
}

async function approveAsTestuser(auth: DeviceAuthorization): Promise<void> {
  const loginPage = await getFollowing(auth.verificationUriComplete ?? auth.verificationUri)
  if (!/name="username"/.test(loginPage)) {
    throw new Error(`no login form reached; page head: ${loginPage.slice(0, 200)}`)
  }
  const afterLogin = await postForm(formAction(loginPage), {
    ...hiddenInputs(loginPage),
    username: 'testuser',
    password: 'testpass',
    credentialId: '',
  })
  const page =
    afterLogin.status >= 300 && afterLogin.status < 400 && afterLogin.location
      ? await getFollowing(new URL(afterLogin.location, ISSUER).toString())
      : afterLogin.body
  // Device consent/approve page: submit its form (user_code is hidden or shown).
  if (!/user_code|kc-device|device/i.test(page)) {
    throw new Error(`unexpected post-login page: ${page.slice(0, 200)}`)
  }
  const approved = await postForm(new URL(formAction(page), ISSUER).toString(), hiddenInputs(page))
  if (approved.status >= 400) {
    throw new Error(`approval POST failed: HTTP ${approved.status}`)
  }
  log(`device login approved as testuser (approval status ${approved.status})`)
}

// ─── Token poll (RFC 8628 §3.5) ────────────────────────────────────────

interface TokenResponse {
  access_token: string
  id_token: string
}

async function pollForTokens(auth: DeviceAuthorization): Promise<TokenResponse> {
  let interval = auth.interval
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: auth.deviceCode,
      }).toString(),
    })
    const doc = (await res.json()) as Record<string, string>
    if (res.ok && doc.access_token)
      return { access_token: doc.access_token, id_token: doc.id_token }
    if (doc.error === 'authorization_pending') {
      await sleep(interval * 1000)
      continue
    }
    if (doc.error === 'slow_down') {
      interval += 5
      await sleep(interval * 1000)
      continue
    }
    throw new Error(`token poll failed: ${doc.error ?? `HTTP ${res.status}`}`)
  }
  throw new Error('token poll timed out after 120 s')
}

/** Decode a JWT payload without verifying (Keycloak minted it; we compare subs). */
function jwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1]
  if (part === undefined) throw new Error('token has no payload segment')
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

// ─── Orchestration ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  await ensureKeycloak()

  log('requesting device authorization…')
  const auth = await requestDeviceAuthorization()
  // The user code is the anti-phishing display value, never a secret.
  log(`user code: ${auth.userCode}`)
  await approveAsTestuser(auth)
  const tokens = await pollForTokens(auth)
  const idClaims = jwtPayload(tokens.id_token)
  const expectedSub = idClaims.sub
  if (typeof expectedSub !== 'string') throw new Error('id_token carries no sub claim')
  log(`minted token for sub ${expectedSub} (token not printed)`)

  // Start the backend in-process with default dev config (issuer/audience
  // defaults match the Phase 0 realm) on an ephemeral port.
  const config = loadConfig({})
  const app = await buildApp({ config })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  log(`backend listening on ${address}`)

  try {
    // Negative probe: no credentials → 401 + WWW-Authenticate.
    const anon = await fetch(`${address}/whoami`)
    if (anon.status !== 401 || !(anon.headers.get('www-authenticate') ?? '').startsWith('Bearer')) {
      throw new Error(`anonymous whoami: expected 401 + WWW-Authenticate, got ${anon.status}`)
    }
    log(
      `anonymous GET /whoami → ${anon.status} www-authenticate=${anon.headers.get('www-authenticate')}`,
    )

    // Positive probe: the minted token must yield the same identity.
    const res = await fetch(`${address}/whoami`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    const body = (await res.json()) as { sub?: string }
    log(`GET /whoami → ${res.status} ${JSON.stringify(body)}`)
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    if (body.sub !== expectedSub) {
      throw new Error(
        `identity mismatch: whoami sub ${String(body.sub)} != token sub ${expectedSub}`,
      )
    }
    log('identity matches the minted token')
  } finally {
    await app.close()
    log('backend closed')
  }

  log('INTEGRATION PASS')
}

try {
  await main()
} catch (err) {
  console.error(`[integration] FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
