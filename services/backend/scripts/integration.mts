/**
 * Integration check for the backend against the live Phase 0 Keycloak stack
 * (docs/cloud-backend-auth.md): whoami (Phase 4/5), the projects/chats CRUD
 * surface (Phase 6a), and the document endpoints with version history
 * (Phase 7a).
 *
 * 1. boot check: probes Keycloak discovery; if it is down, boots the
 *    docker/keycloak compose stack via `sg docker -c` (this environment
 *    reaches docker only through sg).
 * 2. mints REAL access tokens through the device flow, approving them
 *    programmatically via the verification page (cookie-jar form POSTs —
 *    approach adapted from the controller's smoke run1-login.mts, copied
 *    here so the script is self-contained): one for `testuser`, one for a
 *    second user provisioned through the admin REST API so cross-user
 *    isolation runs against two different `sub`s.
 * 3. starts the backend in-process (buildApp + listen, ephemeral port),
 *    backed by a throwaway FILE database (GENOFFICE_BACKEND_DB) and a
 *    throwaway document data dir (GENOFFICE_BACKEND_DATA_DIR).
 * 4. asserts GET /whoami: no token → 401 + WWW-Authenticate; with the
 *    minted token → 200 and the identity matches the token's sub.
 * 5. asserts the projects/chats CRUD end-to-end as user A: create / list /
 *    get / update (version bump) / chat message replace / limit read /
 *    If-Match version guard (stale → 409, fresh → 200, malformed → 400) /
 *    delete, then the same endpoints as user B against A's resources —
 *    every one must answer 404, byte-identical to a missing id.
 * 6. asserts the document endpoints end-to-end as user A: multipart create
 *    of a small real file → byte-exact download → list → guarded PUT
 *    (If-Match fresh → version 2, stale → 409) → conflict=copy as a NEW
 *    document → version history + historical download → raw octet-stream
 *    create; then user B probes A's document (metadata and bytes) — all
 *    404 identical to a missing id — and finally the If-Match-guarded
 *    DELETE (stale 409, matching 204, then 404). Also the document-meta
 *    endpoints (Phase 7d): star/unstar, open-stamp, list fields, strict
 *    body validation, and the same cross-user 404s.
 * 7. cleanup: closes the backend and deletes the throwaway dir.
 *    Keycloak is left as found (the operator tears it down with
 *    `docker compose ... down -v`).
 *
 * Run: npm run -w @genoffice/backend test:integration
 * Never part of plain `npm test`.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildApp, loadConfig } from '../src/index.js'

const ISSUER = 'http://localhost:8080/realms/genoffice'
const MASTER_ISSUER = 'http://localhost:8080/realms/master'
const ADMIN_USERS_URL = 'http://localhost:8080/admin/realms/genoffice/users'
const CLIENT_ID = 'genoffice-desktop'
const SCOPE = 'openid profile email'
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const COMPOSE_FILE = join(REPO_ROOT, 'docker', 'keycloak', 'docker-compose.yml')

/** Second user for the isolation checks (provisioned below if missing). */
const ISO_USER = 'isouser'
const ISO_PASSWORD = 'isopass-locadev'

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

async function approveDeviceLogin(
  auth: DeviceAuthorization,
  username: string,
  password: string,
): Promise<void> {
  const loginPage = await getFollowing(auth.verificationUriComplete ?? auth.verificationUri)
  if (!/name="username"/.test(loginPage)) {
    throw new Error(`no login form reached; page head: ${loginPage.slice(0, 200)}`)
  }
  const afterLogin = await postForm(formAction(loginPage), {
    ...hiddenInputs(loginPage),
    username,
    password,
    credentialId: '',
  })
  let page =
    afterLogin.status >= 300 && afterLogin.status < 400 && afterLogin.location
      ? await getFollowing(new URL(afterLogin.location, ISSUER).toString())
      : afterLogin.body
  if (/name="username"/.test(page)) {
    // Keycloak re-serves the login form (via redirect) on bad credentials.
    throw new Error(`login as ${username} failed (login form re-served)`)
  }

  // Keycloak chains auth forms after login (user-code confirmation — where
  // the code may be a VISIBLE input our hiddenInputs() would miss — then
  // device consent). Keep submitting until a page without a form remains
  // (the success page), filling the known user code when a form asks for it.
  for (let step = 0; step < 6; step++) {
    if (!/action="/.test(page)) {
      log(`device login approved as ${username} (form chain done after ${step} steps)`)
      return
    }
    const data = hiddenInputs(page)
    if (data.user_code === undefined && /name="user_code"/.test(page)) {
      data.user_code = auth.userCode
    }
    const res = await postForm(new URL(formAction(page), ISSUER).toString(), data)
    if (res.status >= 400) {
      throw new Error(`device approval POST failed: HTTP ${res.status}`)
    }
    page =
      res.status >= 300 && res.status < 400 && res.location
        ? await getFollowing(new URL(res.location, ISSUER).toString())
        : res.body
  }
  throw new Error(`device approval for ${username} did not settle on a terminal page`)
}

// ─── Second user for the isolation checks (admin REST API) ─────────────

/**
 * Ensures {@link ISO_USER} exists and is fully usable (admin-cli + the
 * bootstrap admin from the compose file; dev-only credentials). Besides
 * creating it when missing, this idempotently (re)applies the pieces a
 * scripted login needs: a profile (firstName/…), NO required actions
 * (a fresh user would otherwise hit an UPDATE_PROFILE form mid-flow), and
 * the known permanent password.
 */
async function ensureIsolationUser(): Promise<void> {
  const tokenRes = await fetch(`${MASTER_ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'admin',
      password: 'admin',
    }).toString(),
  })
  if (!tokenRes.ok) throw new Error(`admin token failed: HTTP ${tokenRes.status}`)
  const adminToken = ((await tokenRes.json()) as { access_token: string }).access_token
  const authHeaders = {
    authorization: `Bearer ${adminToken}`,
    'content-type': 'application/json',
  }

  const profile = {
    username: ISO_USER,
    enabled: true,
    firstName: 'Iso',
    lastName: 'User',
    email: 'isouser@genoffice.invalid',
    requiredActions: [],
    credentials: [{ type: 'password', value: ISO_PASSWORD, temporary: false }],
  }
  const createRes = await fetch(ADMIN_USERS_URL, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(profile),
  })
  if (createRes.status !== 201 && createRes.status !== 409) {
    throw new Error(
      `provisioning ${ISO_USER} failed: HTTP ${createRes.status} ${await createRes.text()}`,
    )
  }
  if (createRes.status === 409) {
    // Exists (possibly created by an earlier run): reapply profile, clear
    // required actions, and reset the password so the login is deterministic.
    const queryRes = await fetch(`${ADMIN_USERS_URL}?username=${ISO_USER}&exact=true`, {
      headers: authHeaders,
    })
    if (!queryRes.ok) throw new Error(`user lookup failed: HTTP ${queryRes.status}`)
    const users = (await queryRes.json()) as Array<{ id: string }>
    if (users.length !== 1) throw new Error(`expected exactly one ${ISO_USER}, got ${users.length}`)
    const userId = users[0].id
    const { credentials: _c, ...update } = profile
    const updateRes = await fetch(`${ADMIN_USERS_URL}/${userId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(update),
    })
    const pwRes = await fetch(`${ADMIN_USERS_URL}/${userId}/reset-password`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ type: 'password', value: ISO_PASSWORD, temporary: false }),
    })
    if (!updateRes.ok || !pwRes.ok) {
      throw new Error(`user update failed: profile ${updateRes.status}, password ${pwRes.status}`)
    }
  }
  log(`isolation user ${ISO_USER} ready (create status ${createRes.status})`)
}

/** Full device flow as the given user → a real access token + its sub. */
async function mintDeviceToken(
  username: string,
  password: string,
): Promise<{ accessToken: string; sub: string }> {
  // Fresh browser session: leftover SSO cookies from a previous user would
  // skip the login form and break the scripted approval below.
  jar.clear()
  const auth = await requestDeviceAuthorization()
  log(`user code for ${username}: ${auth.userCode}`)
  await approveDeviceLogin(auth, username, password)
  const tokens = await pollForTokens(auth)
  const claims = jwtPayload(tokens.id_token)
  if (typeof claims.sub !== 'string') throw new Error('id_token carries no sub claim')
  log(`minted token for sub ${claims.sub} (token not printed)`)
  return { accessToken: tokens.access_token, sub: claims.sub }
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

// ─── HTTP helper against the backend under test ────────────────────────

interface ApiResponse {
  status: number
  body: any
}

let baseUrl = ''

async function api(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  ifMatch?: string,
): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? undefined : (JSON.parse(text) as any) }
}

function expect(cond: boolean, what: string): void {
  if (!cond) throw new Error(`check failed: ${what}`)
}

/**
 * Raw (non-JSON) request against the backend under test — document uploads
 * and downloads. `body` may be a FormData (multipart, the primary upload
 * shape) or a Buffer (the octet-stream fallback).
 */
async function apiRaw(
  method: string,
  path: string,
  token: string | null,
  body?: FormData | Buffer,
  ifMatch?: string,
  contentType?: string,
): Promise<{ status: number; bytes: Buffer; text: string; headers: Headers; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
    },
    ...(body === undefined ? {} : { body: body as unknown as BodyInit }),
  })
  const bytes = Buffer.from(await res.arrayBuffer())
  let json: any = undefined
  try {
    json = bytes.length === 0 ? undefined : JSON.parse(bytes.toString('utf8'))
  } catch {
    // byte payloads (downloads) are not JSON
  }
  return { status: res.status, bytes, text: bytes.toString('utf8'), headers: res.headers, json }
}

/** A multipart document upload body (the primary upload shape). */
function documentForm(name: string, kind: string, bytes: Buffer, filename: string): FormData {
  const form = new FormData()
  form.append('name', name)
  form.append('kind', kind)
  form.append('file', new Blob([new Uint8Array(bytes)]), filename)
  return form
}

// ─── Orchestration ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  await ensureKeycloak()

  const userA = await mintDeviceToken('testuser', 'testpass')
  await ensureIsolationUser()
  const userB = await mintDeviceToken(ISO_USER, ISO_PASSWORD)
  if (userA.sub === userB.sub) throw new Error('isolation needs two distinct subs')

  // Start the backend in-process with dev issuer/audience defaults on an
  // ephemeral port, backed by a throwaway FILE database (exercises
  // GENOFFICE_BACKEND_DB) and a throwaway document data dir
  // (GENOFFICE_BACKEND_DATA_DIR).
  const dbDir = mkdtempSync(join(tmpdir(), 'genoffice-backend-it-'))
  const config = loadConfig({
    GENOFFICE_BACKEND_DB: join(dbDir, 'integration.db'),
    GENOFFICE_BACKEND_DATA_DIR: join(dbDir, 'documents'),
  })
  const app = await buildApp({ config })
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
  log(`backend listening on ${baseUrl} (db ${config.dbPath})`)

  try {
    // ── whoami probes (Phase 4/5) ──
    const anonRaw = await fetch(`${baseUrl}/whoami`)
    expect(anonRaw.status === 401, `anonymous whoami: expected 401, got ${anonRaw.status}`)
    expect(
      (anonRaw.headers.get('www-authenticate') ?? '').startsWith('Bearer'),
      'anonymous whoami must carry WWW-Authenticate: Bearer',
    )
    await anonRaw.text()
    const who = await api('GET', '/whoami', userA.accessToken)
    expect(who.status === 200 && who.body.sub === userA.sub, 'whoami identity mismatch')
    log(`GET /whoami → 200 sub=${who.body.sub}`)

    // ── projects CRUD as user A ──
    const anonCreate = await api('POST', '/projects', null, { name: 'Nope' })
    expect(
      anonCreate.status === 401 && anonCreate.body.error.code === 'missing_token',
      'anonymous create must 401 missing_token',
    )

    const badBody = await api('POST', '/projects', userA.accessToken, { nom: 'x' })
    expect(
      badBody.status === 400 && badBody.body.error.code === 'validation_failed',
      'invalid create body must 400 validation_failed',
    )

    const created = await api('POST', '/projects', userA.accessToken, {
      name: 'Integration Project',
    })
    expect(created.status === 201 && created.body.version === 1, 'create must 201 with version 1')
    const projectId: string = created.body.id

    const listed = await api('GET', '/projects', userA.accessToken)
    expect(
      listed.status === 200 && listed.body.projects.some((p: any) => p.id === projectId),
      'list must contain the created project',
    )

    const got = await api('GET', `/projects/${projectId}`, userA.accessToken)
    expect(
      got.status === 200 && got.body.name === 'Integration Project',
      'get must return the project',
    )

    const updated = await api('PUT', `/projects/${projectId}`, userA.accessToken, {
      name: 'Integration Project v2',
      files: ['/tmp/integration.md'],
    })
    expect(
      updated.status === 200 &&
        updated.body.version === 2 &&
        updated.body.name === 'Integration Project v2',
      'update must bump version to 2 and rename',
    )
    log(`projects CRUD as A: create/list/get/update ok (${projectId})`)

    // ── chats CRUD as user A ──
    const chat = await api('POST', `/projects/${projectId}/chats`, userA.accessToken)
    expect(
      chat.status === 201 && chat.body.version === 1 && chat.body.messages.length === 0,
      'chat create must 201 empty',
    )
    const chatId: string = chat.body.id

    const put = await api('PUT', `/projects/${projectId}/chats/${chatId}`, userA.accessToken, {
      messages: [
        { role: 'user', text: 'integration hello' },
        {
          role: 'assistant',
          text: 'integration reply',
          tools: [{ name: 'probe', summary: 'ran' }],
        },
      ],
    })
    expect(
      put.status === 200 && put.body.version === 2 && put.body.messages.length === 2,
      'chat message replace must 200 and bump version',
    )
    expect(
      put.body.messages[0].seq === 1 && put.body.messages[1].seq === 2,
      'server must assign seq 1..n',
    )

    const chatGot = await api('GET', `/projects/${projectId}/chats/${chatId}`, userA.accessToken)
    expect(
      chatGot.status === 200 && chatGot.body.messageCount === 2,
      'chat get must report 2 messages',
    )

    const limited = await api(
      'GET',
      `/projects/${projectId}/chats/${chatId}?limit=1`,
      userA.accessToken,
    )
    expect(
      limited.status === 200 &&
        limited.body.messages.length === 1 &&
        limited.body.messages[0].seq === 2,
      'limit read must return the most recent message',
    )

    const chatList = await api('GET', `/projects/${projectId}/chats`, userA.accessToken)
    expect(
      chatList.status === 200 &&
        chatList.body.chats.some((c: any) => c.id === chatId && c.messageCount === 2),
      'chat list must include the chat with count',
    )
    log(`chats CRUD as A: create/replace/get/limit/list ok (${chatId})`)

    // ── If-Match version guard (Phase 6b conflict policy) ──
    // project at version 2, chat at version 2 from the writes above
    const staleProject = await api(
      'PUT',
      `/projects/${projectId}`,
      userA.accessToken,
      { name: 'stale write', files: [] },
      '1',
    )
    expect(
      staleProject.status === 409 && staleProject.body.error.code === 'version_conflict',
      `stale If-Match project PUT must 409 version_conflict (got ${staleProject.status})`,
    )
    const staleChat = await api(
      'PUT',
      `/projects/${projectId}/chats/${chatId}`,
      userA.accessToken,
      { messages: [{ role: 'user', text: 'stale write' }] },
      '1',
    )
    expect(
      staleChat.status === 409 && staleChat.body.error.code === 'version_conflict',
      `stale If-Match chat PUT must 409 version_conflict (got ${staleChat.status})`,
    )
    const freshProject = await api(
      'PUT',
      `/projects/${projectId}`,
      userA.accessToken,
      { name: 'Integration Project v3', files: ['/tmp/integration.md'] },
      '2',
    )
    expect(
      freshProject.status === 200 && freshProject.body.version === 3,
      'matching If-Match project PUT must 200 and bump to version 3',
    )
    const freshChat = await api(
      'PUT',
      `/projects/${projectId}/chats/${chatId}`,
      userA.accessToken,
      {
        messages: [
          { role: 'user', text: 'integration hello' },
          { role: 'assistant', text: 'integration reply' },
          { role: 'user', text: 'third message' },
        ],
      },
      '2',
    )
    expect(
      freshChat.status === 200 && freshChat.body.version === 3,
      'matching If-Match chat PUT must 200 and bump to version 3',
    )
    const badIfMatch = await api(
      'PUT',
      `/projects/${projectId}`,
      userA.accessToken,
      { name: 'x', files: [] },
      '"3"',
    )
    expect(
      badIfMatch.status === 400 && badIfMatch.body.error.code === 'validation_failed',
      'a non-integer If-Match must 400 validation_failed',
    )
    const chatStill = await api('GET', `/projects/${projectId}/chats/${chatId}`, userA.accessToken)
    expect(
      chatStill.status === 200 && chatStill.body.messageCount === 3,
      'chat must carry the 3 guarded-write messages',
    )
    log('If-Match guard: stale → 409 version_conflict, fresh → 200+3, malformed → 400')

    // ── cross-user isolation: user B against user A's resources ──
    const bList = await api('GET', '/projects', userB.accessToken)
    expect(
      bList.status === 200 && !bList.body.projects.some((p: any) => p.id === projectId),
      "B's list must not contain A's project",
    )
    const missing = await api(
      'GET',
      '/projects/00000000-0000-4000-8000-000000000000',
      userB.accessToken,
    )
    const projectBody = { name: 'hijack', files: [] }
    const chatBody = { messages: [{ role: 'user', text: 'hijack' }] }
    const foreignChecks: Array<[string, string, unknown]> = [
      ['GET', `/projects/${projectId}`, undefined],
      ['PUT', `/projects/${projectId}`, projectBody],
      ['DELETE', `/projects/${projectId}`, undefined],
      ['GET', `/projects/${projectId}/chats`, undefined],
      ['POST', `/projects/${projectId}/chats`, undefined],
      ['GET', `/projects/${projectId}/chats/${chatId}`, undefined],
      ['PUT', `/projects/${projectId}/chats/${chatId}`, chatBody],
      ['DELETE', `/projects/${projectId}/chats/${chatId}`, undefined],
    ]
    for (const [method, path, body] of foreignChecks) {
      const res = await api(method, path, userB.accessToken, body)
      expect(
        res.status === 404 && JSON.stringify(res.body) === JSON.stringify(missing.body),
        `B ${method} ${path} must 404 identically to a missing id (got ${res.status} ${JSON.stringify(res.body)})`,
      )
    }
    const aStillOwns = await api('GET', `/projects/${projectId}/chats/${chatId}`, userA.accessToken)
    expect(
      aStillOwns.status === 200 && aStillOwns.body.messages[0].text === 'integration hello',
      'A data must be untouched after B probes',
    )
    log(`isolation: all ${foreignChecks.length} foreign probes as B → 404 identical to missing`)

    // ── deletes (hard, cascading) ──
    const delChat = await api('DELETE', `/projects/${projectId}/chats/${chatId}`, userA.accessToken)
    expect(delChat.status === 204, 'chat delete must 204')
    const chatGone = await api('GET', `/projects/${projectId}/chats/${chatId}`, userA.accessToken)
    expect(chatGone.status === 404, 'deleted chat must 404')

    const chat2 = await api('POST', `/projects/${projectId}/chats`, userA.accessToken)
    expect(chat2.status === 201, 'second chat create must 201 (cascade setup)')
    const chat2Put = await api(
      'PUT',
      `/projects/${projectId}/chats/${chat2.body.id}`,
      userA.accessToken,
      { messages: [{ role: 'user', text: 'cascade me' }] },
    )
    expect(chat2Put.status === 200 && chat2Put.body.version === 2, 'cascade setup PUT must 200')
    const delProject = await api('DELETE', `/projects/${projectId}`, userA.accessToken)
    expect(delProject.status === 204, 'project delete must 204')
    const projectGone = await api('GET', `/projects/${projectId}`, userA.accessToken)
    const chatsGone = await api('GET', `/projects/${projectId}/chats`, userA.accessToken)
    const chat2Gone = await api(
      'GET',
      `/projects/${projectId}/chats/${chat2.body.id}`,
      userA.accessToken,
    )
    expect(
      projectGone.status === 404 && chatsGone.status === 404 && chat2Gone.status === 404,
      'project delete must cascade (project, chat list, chats all 404)',
    )

    // ── B has an independent namespace ──
    const bCreate = await api('POST', '/projects', userB.accessToken, { name: 'B Own Project' })
    expect(bCreate.status === 201, 'B must create its own project')
    log('deletes + cascade + independent namespace ok')

    // ── documents as user A (Phase 7a) ──
    const anonUpload = await apiRaw(
      'POST',
      '/documents',
      null,
      documentForm('x.md', 'md', Buffer.from('x'), 'x.md'),
    )
    expect(
      anonUpload.status === 401 && anonUpload.json.error.code === 'missing_token',
      'anonymous document upload must 401 missing_token',
    )

    const docBytes = Buffer.from(
      '# Integration note\n\nWritten by the Phase 7a integration check; downloaded bytes must match exactly.\n',
    )
    const docCreated = await apiRaw(
      'POST',
      '/documents',
      userA.accessToken,
      documentForm('integration-note.md', 'md', docBytes, 'integration-note.md'),
    )
    expect(
      docCreated.status === 201 &&
        docCreated.json.currentVersion === 1 &&
        docCreated.json.size === docBytes.length,
      `multipart document create must 201 with size (got ${docCreated.status} ${docCreated.text.slice(0, 120)})`,
    )
    const docId: string = docCreated.json.id

    const downloaded = await apiRaw('GET', `/documents/${docId}`, userA.accessToken)
    expect(
      downloaded.status === 200 && downloaded.bytes.equals(docBytes),
      'document download must round-trip the exact uploaded bytes',
    )
    expect(
      downloaded.headers.get('etag') === '1' &&
        (downloaded.headers.get('content-type') ?? '').startsWith('application/octet-stream'),
      'download must carry the version as etag and octet-stream content type',
    )

    const docList = await api('GET', '/documents', userA.accessToken)
    expect(
      docList.status === 200 &&
        docList.body.documents.some(
          (d: any) => d.id === docId && d.currentVersion === 1 && d.size === docBytes.length,
        ),
      'document list must include the created document with metadata',
    )
    log(`documents as A: multipart create + byte-exact download + list ok (${docId})`)

    // raw octet-stream fallback path
    const rawBytes = Buffer.from('raw upload body\n')
    const rawCreate = await apiRaw(
      'POST',
      '/documents?name=integration-raw.md&kind=md',
      userA.accessToken,
      rawBytes,
      undefined,
      'application/octet-stream',
    )
    expect(
      rawCreate.status === 201 && rawCreate.json.size === rawBytes.length,
      `raw octet-stream create must 201 (got ${rawCreate.status})`,
    )
    const rawBack = await apiRaw('GET', `/documents/${rawCreate.json.id}`, userA.accessToken)
    expect(rawBack.bytes.equals(rawBytes), 'raw upload must round-trip its bytes')
    await api('DELETE', `/documents/${rawCreate.json.id}`, userA.accessToken)
    log('documents as A: raw octet-stream create + round-trip ok')

    // version-checked update, 409, conflict copy, history
    const v2Bytes = Buffer.from('# Integration note v2\n\nUpdated through a guarded PUT.\n')
    const docPut = await apiRaw(
      'PUT',
      `/documents/${docId}`,
      userA.accessToken,
      documentForm('integration-note.md', 'md', v2Bytes, 'integration-note.md'),
      '1',
    )
    expect(
      docPut.status === 200 &&
        docPut.json.currentVersion === 2 &&
        docPut.json.size === v2Bytes.length,
      `guarded PUT must 200 and append version 2 (got ${docPut.status})`,
    )
    const stalePut = await apiRaw(
      'PUT',
      `/documents/${docId}`,
      userA.accessToken,
      documentForm(
        'integration-note.md',
        'md',
        Buffer.from('stale write\n'),
        'integration-note.md',
      ),
      '1',
    )
    expect(
      stalePut.status === 409 && stalePut.json.error.code === 'version_conflict',
      `stale document PUT must 409 version_conflict (got ${stalePut.status})`,
    )
    const conflictCopy = await apiRaw(
      'PUT',
      `/documents/${docId}?conflict=copy`,
      userA.accessToken,
      documentForm(
        'integration-note.md',
        'md',
        Buffer.from('my conflicting edit\n'),
        'integration-note.md',
      ),
      '1',
    )
    expect(
      conflictCopy.status === 201 &&
        /^integration-note\.md \(conflict \d{4}-/.test(conflictCopy.json.name) &&
        conflictCopy.json.id !== docId,
      `conflict=copy must 201 a NEW document named "<name> (conflict <ts>)" (got ${conflictCopy.status})`,
    )

    const versions = await api('GET', `/documents/${docId}/versions`, userA.accessToken)
    expect(
      versions.status === 200 &&
        Array.isArray(versions.body.versions) &&
        versions.body.versions.length === 2 &&
        versions.body.versions[0].version === 2 &&
        versions.body.versions[1].version === 1,
      'version history must list version, size, sha256, createdAt newest-first',
    )
    const oldVersion = await apiRaw('GET', `/documents/${docId}/versions/1`, userA.accessToken)
    expect(
      oldVersion.status === 200 && oldVersion.bytes.equals(docBytes),
      'historical version download must return the original bytes',
    )
    log('documents as A: guarded PUT + 409 + conflict-copy + version history ok')

    // ── document meta: server-side recents/starred (Phase 7d) ──
    const starredPut = await api('PUT', `/documents/${docId}/starred`, userA.accessToken, {
      starred: true,
    })
    expect(
      starredPut.status === 200 && starredPut.body.starred === true,
      `star PUT must 200 with the reflected flag (got ${starredPut.status})`,
    )
    const opened = await api('POST', `/documents/${docId}/opened`, userA.accessToken)
    expect(
      opened.status === 200 && typeof opened.body.lastOpenedAt === 'string',
      `opened POST must 200 with a lastOpenedAt stamp (got ${opened.status})`,
    )
    const listWithMeta = await api('GET', '/documents', userA.accessToken)
    const metaRow = listWithMeta.body.documents.find((d: any) => d.id === docId)
    expect(
      metaRow?.starred === true && metaRow?.lastOpenedAt === opened.body.lastOpenedAt,
      'document list must carry starred/lastOpenedAt from document_meta',
    )
    const badStar = await api('PUT', `/documents/${docId}/starred`, userA.accessToken, {
      starred: 'yes',
    })
    expect(
      badStar.status === 400 && badStar.body.error.code === 'validation_failed',
      `non-boolean starred must 400 (got ${badStar.status})`,
    )
    log('documents as A: starred + opened metadata endpoints ok')

    // ── per-file print policy (Ruling 13): default allow, owner-togglable ──
    const policyDeny = await api('PUT', `/documents/${docId}/print-policy`, userA.accessToken, {
      printPolicy: 'deny',
    })
    expect(
      policyDeny.status === 200 && policyDeny.body.printPolicy === 'deny',
      `print-policy PUT must 200 with the reflected policy (got ${policyDeny.status})`,
    )
    expect(
      policyDeny.body.currentVersion === 2,
      `print-policy PUT must not bump the content version (got ${policyDeny.body.currentVersion})`,
    )
    const policyList = await api('GET', '/documents', userA.accessToken)
    const policyRow = policyList.body.documents.find((d: any) => d.id === docId)
    expect(
      policyRow?.printPolicy === 'deny' && policyRow?.starred === true,
      'document list must carry printPolicy from document_meta (star intact)',
    )
    const badPolicy = await api('PUT', `/documents/${docId}/print-policy`, userA.accessToken, {
      printPolicy: 'block',
    })
    expect(
      badPolicy.status === 400 && badPolicy.body.error.code === 'validation_failed',
      `non-enum printPolicy must 400 (got ${badPolicy.status})`,
    )
    log('documents as A: per-file print policy (Ruling 13) ok')

    // ── cross-user isolation on documents (metadata AND bytes) ──
    const missingDoc = await api(
      'GET',
      '/documents/00000000-0000-4000-8000-000000000000',
      userB.accessToken,
    )
    const docProbes: Array<[string, string]> = [
      ['GET', `/documents/${docId}`],
      ['PUT', `/documents/${docId}`],
      ['DELETE', `/documents/${docId}`],
      ['GET', `/documents/${docId}/versions`],
      ['GET', `/documents/${docId}/versions/1`],
    ]
    for (const [method, path] of docProbes) {
      const res = await apiRaw(
        method,
        path,
        userB.accessToken,
        method === 'PUT'
          ? documentForm('hijack.md', 'md', Buffer.from('hijack\n'), 'hijack.md')
          : undefined,
      )
      expect(
        res.status === 404 &&
          (method === 'GET' || JSON.stringify(res.json) === JSON.stringify(missingDoc.body)),
        `B ${method} ${path} must 404 identical to a missing id (got ${res.status})`,
      )
    }
    // the document-meta endpoints are sub-scoped like everything else
    const metaProbes: Array<[string, string, unknown]> = [
      ['PUT', `/documents/${docId}/starred`, { starred: true }],
      ['POST', `/documents/${docId}/opened`, undefined],
    ]
    for (const [method, path, body] of metaProbes) {
      const foreign = await api(method, path, userB.accessToken, body)
      const absent = await api(
        method,
        path.replace(docId, '00000000-0000-4000-8000-000000000000'),
        userB.accessToken,
        body,
      )
      expect(
        foreign.status === 404 &&
          JSON.stringify(foreign.body) === JSON.stringify(absent.body) &&
          JSON.stringify(foreign.body) === JSON.stringify(missingDoc.body),
        `B ${method} ${path} must 404 identical to a missing id (got ${foreign.status})`,
      )
    }
    const bDocList = await api('GET', '/documents', userB.accessToken)
    expect(
      bDocList.status === 200 &&
        !bDocList.body.documents.some((d: any) => d.id === docId || d.id === conflictCopy.json.id),
      "B's document list must not contain A's documents",
    )
    const aStill = await apiRaw('GET', `/documents/${docId}`, userA.accessToken)
    expect(aStill.bytes.equals(v2Bytes), 'A document bytes must be untouched after B probes')
    log(
      `isolation: all ${docProbes.length} foreign document probes as B → 404 identical to missing`,
    )

    // ── document deletes: If-Match guarded (stale 409, matching 204) ──
    const staleDelete = await api(
      'DELETE',
      `/documents/${docId}`,
      userA.accessToken,
      undefined,
      '1',
    )
    expect(
      staleDelete.status === 409 && staleDelete.body.error.code === 'version_conflict',
      `stale document DELETE must 409 version_conflict (got ${staleDelete.status})`,
    )
    const stillThere = await apiRaw('GET', `/documents/${docId}`, userA.accessToken)
    expect(stillThere.status === 200, 'document must survive a stale delete')
    const deleted = await api('DELETE', `/documents/${docId}`, userA.accessToken, undefined, '2')
    expect(deleted.status === 204, `matching document DELETE must 204 (got ${deleted.status})`)
    const docGone = await api('GET', `/documents/${docId}`, userA.accessToken)
    const versionsGone = await api('GET', `/documents/${docId}/versions`, userA.accessToken)
    expect(
      docGone.status === 404 && versionsGone.status === 404,
      'deleted document and its history must 404',
    )
    log('documents as A: If-Match DELETE (stale 409 → matching 204) ok')
  } finally {
    await app.close()
    log('backend closed')
    rmSync(dbDir, { recursive: true, force: true })
  }

  log('INTEGRATION PASS')
}

try {
  await main()
} catch (err) {
  console.error(`[integration] FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
