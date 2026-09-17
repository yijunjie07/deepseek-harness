/** Durable, revocable browser sessions for an opt-in Web deployment. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'
import type { BrowserSessionId, BrowserSigningKeyId } from './rpc.ts'

const RECORD = credentialKey('client-connection', 'managed-browser-sessions')
const DAY = 86_400_000
const random = (): string => randomBytes(32).toString('base64url')
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const sessionIdSchema = tokenSchema.transform(value => value as BrowserSessionId)
const keyIdSchema = tokenSchema.transform(value => value as BrowserSigningKeyId)
const sessionSchema = z.object({
  id: sessionIdSchema,
  authority: z.string().min(1),
  name: z.string().max(100),
  userAgent: z.string().max(512),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
})
const stateSchema = z.object({
  version: z.literal(1),
  keyId: keyIdSchema,
  secret: tokenSchema,
  sessions: z.array(sessionSchema),
})
type State = z.infer<typeof stateSchema>
type Session = z.infer<typeof sessionSchema>
const PROCESS_TOKENS = new WeakMap<object, { token: string }>()

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), id: sessionIdSchema, name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal('revoke'), id: sessionIdSchema }).strict(),
  z.object({ action: z.enum(['revoke-others', 'logout', 'logout-all', 'rotate-cookie', 'rotate-token', 'rotate-key']) }).strict(),
])

function header(request: ConnectionTrustRequest, name: string): string | undefined {
  const headers = request.headers
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function authority(request: ConnectionTrustRequest): string | undefined {
  const host = header(request, 'host')
  if (host === undefined) return undefined
  try { return new URL(`http://${host}`).host } catch { return undefined }
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function cookieName(host: string): string {
  return `dsh-auth-${createHash('sha256').update(host).digest('base64url')}`
}

function signedValue(state: State, id: string): string {
  const body = `v2.${state.keyId}.${id}`
  return `${body}.${createHmac('sha256', Buffer.from(state.secret, 'base64url')).update(body).digest('base64url')}`
}

/** Persistent session owner; mutations commit before replacement cookies are sent. */
export class ManagedBrowserAuth {
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private readonly activity = new Map<BrowserSessionId, number>()

  private constructor(
    private readonly credentials: CredentialProvider,
    private state: State,
    private readonly launch: { token: string },
    private readonly maxAgeDays: number,
    private readonly secureCookie: boolean,
    private readonly maxSessions: number,
  ) {}

  /**
   * Load or initialize revocable sessions, refusing malformed stored state.
   * @param owner - root context retaining the launch token across plugin reloads.
   * @param credentials - persistent credential provider.
   * @param maxAgeDays - absolute cookie lifetime in days.
   * @param secureCookie - require HTTPS for browser cookies.
   * @param maxSessions - maximum active sessions retained across authorities.
   * @returns initialized authentication owner.
   */
  static async create(
    owner: object, credentials: CredentialProvider, maxAgeDays: number, secureCookie: boolean, maxSessions: number,
  ): Promise<ManagedBrowserAuth> {
    if (!Number.isSafeInteger(Date.now() + maxAgeDays * DAY) || maxAgeDays <= 0) {
      throw new Error('client-connection: invalid managed browser cookie lifetime')
    }
    const record = await credentials.modifyRecord(RECORD, (current) => {
      if (current !== undefined) return Promise.resolve(undefined)
      return Promise.resolve({ kind: 'grant', payload: { version: 1, keyId: random(), secret: random(), sessions: [] } })
    })
    if (record?.kind !== 'grant') throw new Error('client-connection: managed browser credentials missing')
    const state = stateSchema.parse(record.payload)
    let launch = PROCESS_TOKENS.get(owner)
    if (launch === undefined) {
      launch = { token: random() }
      PROCESS_TOKENS.set(owner, launch)
    }
    return new ManagedBrowserAuth(credentials, state, launch, maxAgeDays, secureCookie, maxSessions)
  }

  /**
   * Subscribe to committed session invalidation; callbacks must not throw.
   * @param listener - carrier callback which terminates unauthorized connections.
   * @returns disposer removing the callback.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Produce the current launch URL.
   * @param baseUrl - canonical browser origin.
   * @returns root URL carrying the current launch token.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL('/', baseUrl)
    url.searchParams.set('token', this.launch.token)
    return url.href
  }

  private session(request: ConnectionTrustRequest): Session | undefined {
    const host = authority(request)
    if (host === undefined) return undefined
    const prefix = `${cookieName(host)}=`
    const value = header(request, 'cookie')?.split(';').map(part => part.trim())
      .find(part => part.startsWith(prefix))?.slice(prefix.length)
    if (value === undefined) return undefined
    const id = value.split('.')[2]
    if (id === undefined || !tokenSchema.safeParse(id).success || !equal(value, signedValue(this.state, id))) return undefined
    const session = this.state.sessions.find(row => row.id === id && row.authority === host)
    const now = Date.now()
    return session !== undefined && session.createdAt <= now && session.expiresAt > now
      && session.expiresAt - session.createdAt <= this.maxAgeDays * DAY ? session : undefined
  }

  /**
   * Verify a live authority-bound session and record its process-local activity.
   * @param request - incoming request headers.
   * @returns whether a non-revoked, unexpired session authenticates the request.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const session = this.session(request)
    if (session === undefined) return false
    this.activity.set(session.id, Date.now())
    return true
  }

  private cookie(session: Session, expired = false): string {
    const value = expired ? '' : signedValue(this.state, session.id)
    const expiresAt = expired ? 0 : session.expiresAt
    const age = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
    return `${cookieName(session.authority)}=${value}; Max-Age=${String(age)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict${this.secureCookie ? '; Secure' : ''}`
  }

  private newSession(request: ConnectionTrustRequest, host: string, previous?: Session): Session {
    const now = Date.now()
    return {
      id: sessionIdSchema.parse(random()), authority: host, name: previous?.name ?? '',
      userAgent: (header(request, 'user-agent') ?? '').slice(0, 512),
      createdAt: now, lastSeenAt: now, expiresAt: now + this.maxAgeDays * DAY,
    }
  }

  private transaction<T>(run: (draft: State) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state)
      draft.sessions = draft.sessions.filter(row => row.expiresAt > Date.now())
      for (const row of draft.sessions) row.lastSeenAt = this.activity.get(row.id) ?? row.lastSeenAt
      const result = run(draft)
      const saved = await this.credentials.modifyRecord(RECORD, () => Promise.resolve({ kind: 'grant', payload: draft }))
      if (saved?.kind !== 'grant') throw new Error('client-connection: browser session write failed')
      this.state = stateSchema.parse(saved.payload)
      for (const id of this.activity.keys()) {
        if (!this.state.sessions.some(row => row.id === id)) this.activity.delete(id)
      }
      return result
    })
    this.queue = operation.then(() => {}, () => {})
    return operation
  }

  /**
   * Commit a login before sending its cookie; old stateless cookies are refused.
   * @param request - incoming root or configured-index request.
   * @param response - response owned when the result is false.
   * @returns whether the caller may serve the index.
   */
  async authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll('token')
    const token = tokens[0]
    const host = authority(request)
    if (request.method === 'GET' && url.pathname === '/' && tokens.length === 1
      && host !== undefined && token !== undefined && equal(token, this.launch.token)) {
      const session = await this.transaction((draft) => {
        // Recheck after queued revocation or token rotation has committed.
        if (!equal(token, this.launch.token)) return undefined
        const current = this.session(request)
        if (current !== undefined) return current
        if (draft.sessions.length >= this.maxSessions) return undefined
        const created = this.newSession(request, host)
        draft.sessions.push(created)
        return created
      })
      if (session !== undefined) {
        response.writeHead(303, {
          'cache-control': 'no-store', 'location': '/', 'referrer-policy': 'no-referrer',
          'set-cookie': this.cookie(session),
        })
        response.end()
        return false
      }
    }
    if (this.isAuthenticated(request)) {
      if (request.method === 'GET' && url.pathname === '/' && tokens.length > 0) {
        response.writeHead(303, { 'location': '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        response.end()
        return false
      }
      if (tokens.length === 0) return true
    }
    response.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    response.end(request.method === 'HEAD' ? undefined : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
    return false
  }

  /**
   * Serve the opt-in security API after Connection's Host/Origin fence.
   * @param request - cookie-authenticated GET or JSON POST; mutations require a same-origin Origin.
   * @returns a no-store device list or mutation result, never a signing secret.
   */
  async manage(request: Request): Promise<Response> {
    const trust = { headers: request.headers }
    const current = this.session(trust)
    const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    if (current === undefined) return new Response('unauthorized', { status: 401, headers })
    if (request.method === 'GET') {
      const sessions = this.state.sessions.filter(row => row.authority === current.authority && row.expiresAt > Date.now())
        .map(row => ({ ...row, lastSeenAt: this.activity.get(row.id) ?? row.lastSeenAt, current: row.id === current.id }))
      return Response.json({ sessions, keyId: this.state.keyId, maxAgeDays: this.maxAgeDays }, { headers })
    }
    const expectedOrigin = `${this.secureCookie ? 'https' : new URL(request.url).protocol.slice(0, -1)}://${current.authority}`
    if (request.headers.get('origin') !== expectedOrigin) return new Response('forbidden', { status: 403, headers })
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      return new Response('JSON required', { status: 415, headers })
    }
    const body = await request.text()
    if (body.length > 2048) return new Response('request too large', { status: 413, headers })
    let json: unknown
    try { json = JSON.parse(body) } catch { return new Response('invalid JSON', { status: 400, headers }) }
    const parsed = actionSchema.safeParse(json)
    if (!parsed.success) return new Response('invalid action', { status: 400, headers })
    const action = parsed.data
    const result = await this.transaction((draft) => {
      const actor = this.session(trust)
      if (actor === undefined) return { status: 401 }
      if ('id' in action && !draft.sessions.some(row => row.id === action.id && row.authority === actor.authority)) {
        return { status: 404 }
      }
      let replacement: Session | undefined
      let signedOut = false
      switch (action.action) {
        case 'rename':
          for (const row of draft.sessions) {
            if (row.id === action.id) row.name = action.name
          }
          break
        case 'revoke':
          draft.sessions = draft.sessions.filter(row => row.id !== action.id)
          signedOut = action.id === actor.id
          break
        case 'revoke-others':
          draft.sessions = draft.sessions.filter(row => row.authority !== actor.authority || row.id === actor.id)
          break
        case 'logout':
          draft.sessions = draft.sessions.filter(row => row.id !== actor.id)
          signedOut = true
          break
        case 'logout-all': draft.sessions = []; signedOut = true; break
        case 'rotate-cookie':
          replacement = this.newSession(trust, actor.authority, actor)
          draft.sessions = draft.sessions.filter(row => row.id !== actor.id)
          draft.sessions.push(replacement)
          break
        case 'rotate-key':
          draft.secret = random()
          draft.keyId = keyIdSchema.parse(random())
          draft.sessions = []
          signedOut = true
          break
        case 'rotate-token': break
      }
      return { status: 200, replacement, signedOut }
    })
    if (result.status !== 200) return new Response('session unavailable', { status: result.status, headers })
    const rotatesToken = ['rotate-token', 'rotate-key', 'logout-all'].includes(action.action)
    if (rotatesToken) this.launch.token = random()
    if (result.replacement !== undefined) headers.set('set-cookie', this.cookie(result.replacement))
    else if (result.signedOut) headers.set('set-cookie', this.cookie(current, true))
    // Disconnect live streams only after durable invalidation succeeds.
    for (const listener of this.listeners) {
      try { listener() } catch (error) { console.error('browser session invalidation listener failed', error) }
    }
    return Response.json({
      signedOut: result.signedOut ?? false,
      ...(rotatesToken ? { loginUrl: this.authenticatedUrl(expectedOrigin) } : {}),
    }, { headers })
  }
}
