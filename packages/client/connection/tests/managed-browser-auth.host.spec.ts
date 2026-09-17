/** Revocation, rotation, persistence failures, and authority isolation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { ManagedBrowserAuth } from '../src/managed-browser-auth.ts'
import { RecordCredentials } from './browser-credentials.ts'

const host = 'dsh.example.com'
const origin = `https://${host}`
const trust = (cookie: string, authority = host) => ({ headers: { host: authority, cookie } })

interface DeviceView {
  sessions: { id: string; name: string; current: boolean }[]
  keyId: string
}

interface RotationResult {
  signedOut: boolean
  loginUrl: string
}

async function view(response: Promise<Response>): Promise<DeviceView> {
  return (await response).json() as Promise<DeviceView>
}

async function rotation(response: Promise<Response>): Promise<RotationResult> {
  return (await response).json() as Promise<RotationResult>
}

async function fixture(store = new RecordCredentials(), owner = {}, limit = 100) {
  const auth = await ManagedBrowserAuth.create(owner, store as unknown as CredentialProvider, 30, true, limit)
  return { auth, store }
}

async function login(auth: ManagedBrowserAuth, authority = host, url = auth.authenticatedUrl(`https://${authority}`)) {
  let status = 0
  let headers: Readonly<Record<string, string>> = {}
  await auth.authorizeIndex({ method: 'GET', url, headers: { host: authority, 'user-agent': 'Test browser' } }, {
    writeHead(code, values) { status = code; headers = values ?? {} }, end() {},
  })
  return { status, headers, cookie: headers['set-cookie']?.split(';')[0] ?? '' }
}

function manage(auth: ManagedBrowserAuth, cookie: string, action?: unknown, authority = host, customOrigin = `https://${authority}`) {
  return auth.manage(new Request(`http://${authority}/api/browser-security`, {
    method: action === undefined ? 'GET' : 'POST',
    headers: { host: authority, cookie, origin: customOrigin, 'content-type': 'application/json' },
    ...(action === undefined ? {} : { body: JSON.stringify(action) }),
  }))
}

afterEach(() => vi.useRealTimers())

describe('managed browser authentication', () => {
  it('persists separate devices and revokes one across restart without revoking the current device', async () => {
    const { auth, store } = await fixture()
    const first = await login(auth)
    const second = await login(auth)
    expect(first.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict; Secure')
    const devices = await view(manage(auth, first.cookie))
    expect(devices.sessions).toHaveLength(2)
    expect(devices.sessions.map(row => row.current)).toEqual([true, false])
    const id = devices.sessions[1]!.id
    expect((await manage(auth, first.cookie, { action: 'rename', id, name: 'Phone' })).status).toBe(200)
    expect((await view(manage(auth, first.cookie))).sessions[1]!.name).toBe('Phone')
    const listener = vi.fn()
    const off = auth.subscribe(listener)
    expect((await manage(auth, first.cookie, { action: 'revoke', id })).status).toBe(200)
    expect(listener).toHaveBeenCalledOnce()
    off()
    expect(auth.isAuthenticated(trust(first.cookie))).toBe(true)
    expect(auth.isAuthenticated(trust(second.cookie))).toBe(false)
    const restarted = (await fixture(store)).auth
    expect(restarted.isAuthenticated(trust(first.cookie))).toBe(true)
    expect(restarted.isAuthenticated(trust(second.cookie))).toBe(false)
    expect(restarted.authenticatedUrl(origin)).not.toBe(auth.authenticatedUrl(origin))
  })

  it('rotates the current cookie and launch token independently, then invalidates all cookies with key rotation', async () => {
    const { auth, store } = await fixture()
    const first = await login(auth)
    const other = await login(auth)
    const oldUrl = auth.authenticatedUrl(origin)
    const rotated = await manage(auth, first.cookie, { action: 'rotate-cookie' })
    const cookie = rotated.headers.get('set-cookie')!.split(';')[0]!
    expect(auth.isAuthenticated(trust(first.cookie))).toBe(false)
    expect(auth.isAuthenticated(trust(cookie))).toBe(true)
    expect(auth.isAuthenticated(trust(other.cookie))).toBe(true)
    expect(auth.authenticatedUrl(origin)).toBe(oldUrl)
    const tokenResult = await rotation(manage(auth, cookie, { action: 'rotate-token' }))
    expect(tokenResult.loginUrl).not.toBe(oldUrl)
    expect((await login(auth, host, oldUrl)).status).toBe(401)
    expect(auth.isAuthenticated(trust(cookie))).toBe(true)
    const before = await view(manage(auth, cookie))
    const keyResult = await rotation(manage(auth, cookie, { action: 'rotate-key' }))
    expect(keyResult.signedOut).toBe(true)
    expect(auth.isAuthenticated(trust(cookie))).toBe(false)
    expect(auth.isAuthenticated(trust(other.cookie))).toBe(false)
    expect((await login(auth, host, tokenResult.loginUrl)).status).toBe(401)
    const fresh = await login(auth, host, keyResult.loginUrl)
    expect(fresh.status).toBe(303)
    expect((await view(manage(auth, fresh.cookie))).keyId).not.toBe(before.keyId)
    expect((await fixture(store)).auth.isAuthenticated(trust(cookie))).toBe(false)
  })

  it('scopes lists and targeted revocation to an authority and requires exact HTTPS Origin for writes', async () => {
    const { auth } = await fixture()
    const first = await login(auth)
    const remote = await login(auth, 'other.example.com')
    const foreign = await view(manage(auth, remote.cookie, undefined, 'other.example.com'))
    expect((await view(manage(auth, first.cookie))).sessions).toHaveLength(1)
    expect((await manage(auth, first.cookie, { action: 'revoke', id: foreign.sessions[0]!.id })).status).toBe(404)
    expect((await manage(auth, first.cookie, { action: 'logout' }, host, 'https://evil.example')).status).toBe(403)
    expect((await manage(auth, first.cookie, { action: 'logout' }, host, `http://${host}`)).status).toBe(403)
    expect((await manage(auth, first.cookie, { action: 'logout' }, host, '')).status).toBe(403)
    expect((await manage(auth, '', { action: 'rotate-key' })).status).toBe(401)
    expect(auth.isAuthenticated(trust(first.cookie, 'other.example.com'))).toBe(false)
    expect(auth.isAuthenticated(trust(`${first.cookie}x`))).toBe(false)
  })

  it('serializes concurrent login writes and never publishes cookies or revocations after failed persistence', async () => {
    const { auth, store } = await fixture()
    const logins = await Promise.all([login(auth), login(auth), login(auth)])
    expect((await view(manage(auth, logins[0].cookie))).sessions).toHaveLength(3)
    store.discardWrites = true
    await expect(login(auth)).rejects.toThrow('write failed')
    const listener = vi.fn()
    auth.subscribe(listener)
    await expect(manage(auth, logins[0].cookie, { action: 'logout-all' })).rejects.toThrow('write failed')
    expect(listener).not.toHaveBeenCalled()
    expect(auth.isAuthenticated(trust(logins[0].cookie))).toBe(true)
    store.discardWrites = false
    expect((await manage(auth, logins[0].cookie, { action: 'revoke-others' })).status).toBe(200)
    expect(auth.isAuthenticated(trust(logins[1].cookie))).toBe(false)
    expect(auth.isAuthenticated(trust(logins[0].cookie))).toBe(true)
    expect((await manage(auth, logins[0].cookie, { action: 'logout' })).headers.get('set-cookie')).toContain('Max-Age=0')
    expect(auth.isAuthenticated(trust(logins[0].cookie))).toBe(false)
  })

  it('bounds sessions, rejects malformed operations, and prunes expired records', async () => {
    vi.useFakeTimers()
    const { auth } = await fixture(undefined, {}, 1)
    const first = await login(auth)
    expect((await login(auth)).status).toBe(401)
    for (const action of [{ action: 'unknown' }, { action: 'rename', id: 'bad', name: 'x' }, { action: 'rotate-key', extra: true }]) {
      expect((await manage(auth, first.cookie, action)).status).toBe(400)
    }
    expect((await manage(auth, first.cookie, { action: 'rename', id: 'a'.repeat(43), name: 'x'.repeat(3000) })).status).toBe(413)
    vi.setSystemTime(Date.now() + 31 * 86_400_000)
    expect(auth.isAuthenticated(trust(first.cookie))).toBe(false)
    expect((await login(auth)).status).toBe(303)
  })

  it('rechecks a queued token exchange after rotation commits', async () => {
    const { auth, store } = await fixture()
    const first = await login(auth)
    const oldUrl = auth.authenticatedUrl(origin)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const modify = store.modifyRecord.bind(store)
    vi.spyOn(store, 'modifyRecord').mockImplementationOnce(async (key, mutate) => {
      entered.resolve(undefined)
      await release.promise
      return modify(key, mutate)
    })
    const rotation = manage(auth, first.cookie, { action: 'rotate-token' })
    await entered.promise
    const pendingLogin = login(auth, host, oldUrl)
    release.resolve(undefined)
    expect((await rotation).status).toBe(200)
    expect((await pendingLogin).status).toBe(401)
  })

  it('global logout invalidates every authority and the previous launch link', async () => {
    const { auth } = await fixture()
    const first = await login(auth)
    const remote = await login(auth, 'other.example.com')
    const oldUrl = auth.authenticatedUrl(origin)
    const before = await view(manage(auth, first.cookie))
    const result = await rotation(manage(auth, first.cookie, { action: 'logout-all' }))
    expect(result.signedOut).toBe(true)
    expect(auth.isAuthenticated(trust(first.cookie))).toBe(false)
    expect(auth.isAuthenticated(trust(remote.cookie, 'other.example.com'))).toBe(false)
    expect((await login(auth, host, oldUrl)).status).toBe(401)
    const fresh = await login(auth, host, result.loginUrl)
    const after = await view(manage(auth, fresh.cookie))
    expect(after.keyId).toBe(before.keyId)
    expect(after.sessions).toHaveLength(1)
  })
})
