/** Cookie-authenticated transport used only by the optional security settings section. */
import type { BrowserSessionId, BrowserSigningKeyId } from '@deepseek-ai/dsh-client-connection/src/rpc.ts'

/** One browser session, scoped by the server to the current authority. */
export interface BrowserDevice {
  id: BrowserSessionId
  name: string
  userAgent: string
  current: boolean
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

/** Security settings response. Signing keys and cookie values never enter this view. */
export interface BrowserSecurityState {
  sessions: BrowserDevice[]
  maxAgeDays: number
  keyId: BrowserSigningKeyId
}

/** Mutation result; a new launch URL is returned only by explicit token rotation. */
export interface BrowserSecurityResult {
  signedOut: boolean
  loginUrl?: string
}

/** Commands passed as plain callbacks to the settings component. */
export interface BrowserSecurityActions {
  load: (signal: AbortSignal) => Promise<BrowserSecurityState>
  change: (action: string, fields?: { id: BrowserSessionId; name?: string }) => Promise<BrowserSecurityResult>
}

async function checked(request: RequestInit): Promise<unknown> {
  const response = await fetch('/api/browser-security', { ...request, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return response.json()
}

/**
 * Build callbacks without exposing the transport object to React components.
 * @returns authenticated load and mutation callbacks.
 */
export function browserSecurityActions(): BrowserSecurityActions {
  return {
    async load(signal) {
      const value = await checked({ signal }) as BrowserSecurityState
      if (!Array.isArray(value.sessions) || typeof value.keyId !== 'string' || typeof value.maxAgeDays !== 'number'
        || !value.sessions.every(row => typeof row.id === 'string' && typeof row.name === 'string'
          && typeof row.userAgent === 'string' && typeof row.current === 'boolean'
          && [row.createdAt, row.lastSeenAt, row.expiresAt].every(Number.isFinite))) {
        throw new Error('invalid browser security response')
      }
      return value
    },
    async change(action, fields) {
      const value = await checked({
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...fields }),
      }) as BrowserSecurityResult
      if (typeof value.signedOut !== 'boolean' || (value.loginUrl !== undefined && typeof value.loginUrl !== 'string')) {
        throw new Error('invalid browser security mutation response')
      }
      if (value.loginUrl !== undefined && new URL(value.loginUrl).origin !== location.origin) {
        throw new Error('invalid browser security login origin')
      }
      return value
    },
  }
}
