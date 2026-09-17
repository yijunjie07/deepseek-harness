// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BrowserSecuritySection } from '../src/client/BrowserSecuritySection.tsx'
import type { BrowserDevice, BrowserSecurityActions, BrowserSecurityState } from '../src/client/browser-security-api.ts'
import { en, zh } from '../src/client/locales.ts'

type Props = Parameters<typeof BrowserSecuritySection>[0]
const unusedHook = (() => { throw new Error('unused by login devices') }) as never
const kit = {
  useSessions: unusedHook, useSessionPendingInteraction: unusedHook, usePanelInfo: unusedHook,
  useResource: unusedHook, useWorkspaces: unusedHook, close: vi.fn(),
}
const device: BrowserDevice = {
  id: 'current-device' as BrowserDevice['id'], name: 'My laptop', current: true,
  userAgent: 'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36',
  createdAt: 1_789_600_000_000, lastSeenAt: 1_789_601_000_000, expiresAt: 1_792_192_000_000,
}

function mount(sessions = [device], locale = en) {
  const state: BrowserSecurityState = { sessions, maxAgeDays: 30, keyId: 'test-key' as BrowserSecurityState['keyId'] }
  const load = vi.fn<BrowserSecurityActions['load']>().mockResolvedValue(state)
  const change = vi.fn<BrowserSecurityActions['change']>().mockResolvedValue({ signedOut: false })
  const t: Props['t'] = key => (locale as Record<string, string>)[key] ?? key
  const view = render(<BrowserSecuritySection {...kit} t={t} load={load} change={change} />)
  return { ...view, load, change }
}

async function openMenu(index = 0) {
  const rows = await screen.findAllByRole('article')
  fireEvent.click(within(rows[index]!).getByRole('button', { name: 'More' }))
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('login devices', () => {
  it('shows a compact summary without technical controls, details, or duplicate logout', async () => {
    mount()
    await screen.findByText('My laptop')
    expect(screen.getByText('Chrome')).toBeTruthy()
    expect(screen.getByText('This device')).toBeTruthy()
    expect(screen.queryByText(device.userAgent)).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    expect(screen.queryByRole('button', { name: en['security.rotateCookie'] })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign out other devices' }).disabled).toBe(true)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      'Refresh devices', 'More', 'Sign out other devices', 'Advanced security',
    ])
  })

  it('opens and closes device details without changing the session', async () => {
    const { change } = mount()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View details' }))
    expect(screen.getByText(device.userAgent)).toBeTruthy()
    expect(screen.getByText(en['security.deviceNote'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
    expect(screen.queryByText(device.userAgent)).toBeNull()
    expect(change).not.toHaveBeenCalled()
  })

  it('renames only the selected device, preserves failed drafts, and supports cancel', async () => {
    const { change } = mount([device, { ...device, id: 'other' as BrowserDevice['id'], current: false, name: 'Phone' }])
    change.mockRejectedValueOnce(new Error('offline'))
    await openMenu(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My phone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await screen.findByRole('alert')
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('My phone')
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => { expect(screen.queryByRole('textbox')).toBeNull() })
    expect(change).toHaveBeenLastCalledWith('rename', { id: 'other', name: 'My phone' })
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(change).toHaveBeenCalledTimes(2)
  })

  it('requires confirmation for targeted logout and leaves the session unchanged on cancel', async () => {
    const { change } = mount([device, { ...device, id: 'other' as BrowserDevice['id'], current: false }])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openMenu(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(confirm).toHaveBeenCalledWith(en['security.confirm.revoke'])
    expect(change).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await openMenu(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    await waitFor(() => { expect(change).toHaveBeenCalledWith('revoke', { id: 'other' }) })
  })

  it('signs out the current device through its single menu action', async () => {
    const { change } = mount()
    change.mockResolvedValue({ signedOut: true })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect((await screen.findByRole('status')).textContent).toBe(en['security.signedOut'])
    expect(change).toHaveBeenCalledWith('logout', undefined)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('enables sign out others only when other sessions are present', async () => {
    const { change } = mount([device, { ...device, id: 'other' as BrowserDevice['id'], current: false }])
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await screen.findAllByRole('article')
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Sign out other devices' })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => { expect(change).toHaveBeenCalledWith('revoke-others', undefined) })
  })

  it.each([
    ['rotate-cookie', 'security.rotateCookie'], ['rotate-token', 'security.rotateToken'],
    ['logout-all', 'security.logoutAll'], ['rotate-key', 'security.rotateKey'],
  ] as const)('keeps %s behind disclosure and an action-specific confirmation', async (action, label) => {
    const { change } = mount()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await screen.findByText('My laptop')
    expect(screen.queryByRole('button', { name: en[label] })).toBeNull()
    const advanced = screen.getByRole('button', { name: 'Advanced security' })
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(advanced)
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    if (action === 'rotate-key') {
      expect(screen.queryByRole('button', { name: en[label] })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Maintenance' }))
    }
    fireEvent.click(screen.getByRole('button', { name: en[label] }))
    expect(confirm).toHaveBeenCalledWith(en[`security.confirm.${action}`])
    expect(change).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    change.mockResolvedValue({ signedOut: action === 'logout-all' || action === 'rotate-key', loginUrl: 'https://example.test/?token=test-only' })
    fireEvent.click(screen.getByRole('button', { name: en[label] }))
    await screen.findByRole('link', { name: 'Sign in again' })
    expect(change).toHaveBeenCalledWith(action, undefined)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'New login link' }).value).toBe('https://example.test/?token=test-only')
  })

  it.each([
    ['Chrome/152 Safari/537 Edg/152', 'Microsoft Edge'], ['Chrome/152 OPR/1', 'Opera'],
    ['Chrome/152 SamsungBrowser/1', 'Samsung Internet'], ['FxiOS/1 Safari/537', 'Firefox'],
    ['CriOS/1 Safari/537', 'Chrome'], ['Version/1 Safari/537', 'Safari'], ['', 'Unknown browser'],
  ])('summarizes %s without exposing the full browser description', async (userAgent, label) => {
    mount([{ ...device, userAgent }])
    expect(await screen.findByText(label)).toBeTruthy()
  })

  it('uses Chinese copy for the compact page', async () => {
    mount([device], zh)
    await screen.findByText('My laptop')
    expect(screen.getByRole('heading', { name: '登录设备' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '高级安全' }).getAttribute('aria-expanded')).toBe('false')
  })
})
