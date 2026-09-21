/**
 * Integration check for the backend against the live Phase 0 Keycloak stack
 * (docs/cloud-backend-auth.md): whoami (Phase 4/5) plus the projects/chats
 * CRUD surface (Phase 6a).
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
 *    backed by a throwaway FILE database (exercises GENOFFICE_BACKEND_DB).
 * 4. asserts GET /whoami: no token → 401 + WWW-Authenticate; with the
 *    minted token → 200 and the identity matches the token's sub.
 * 5. asserts the projects/chats CRUD end-to-end as user A: create / list /
 *    get / update (version bump) / chat message replace / limit read /
 *    If-Match version guard (stale → 409, fresh → 200, malformed → 400) /
 *    delete, then the same endpoints as user B against A's resources —
 *    every one must answer 404, byte-identical to a missing id.
 * 6. cleanup: closes the backend and deletes the throwaway DB dir.
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

// ─── Orchestration ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  await ensureKeycloak()

  const userA = await mintDeviceToken('testuser', 'testpass')
  await ensureIsolationUser()
  const userB = await mintDeviceToken(ISO_USER, ISO_PASSWORD)
  if (userA.sub === userB.sub) throw new Error('isolation needs two distinct subs')

  // Start the backend in-process with dev issuer/audience defaults on an
  // ephemeral port, backed by a throwaway FILE database so the integration
  // run also covers the GENOFFICE_BACKEND_DB file path.
  const dbDir = mkdtempSync(join(tmpdir(), 'genoffice-backend-it-'))
  const config = loadConfig({ GENOFFICE_BACKEND_DB: join(dbDir, 'integration.db') })
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
