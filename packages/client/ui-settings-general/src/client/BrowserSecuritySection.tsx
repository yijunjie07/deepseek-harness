/** Login-device controls; data and mutations arrive through the slot injection. */
import { useEffect, useId, useState } from 'react'
import { Button, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserSecurityActions, BrowserSecurityState } from './browser-security-api.ts'
import css from './BrowserSecuritySection.module.css'

type Props = PropsRuntime<'settings.section'> & PropsLocale<'settings'> & BrowserSecurityActions
type ConfirmAction = 'revoke' | 'logout' | 'revoke-others' | 'rotate-cookie' | 'rotate-token' | 'logout-all' | 'rotate-key'

function browserName(userAgent: string, t: Props['t']) {
  if (/Edg(?:e|A|iOS)?\//.test(userAgent)) return t('security.browser.edge')
  if (/(?:OPR|Opera)\//.test(userAgent)) return t('security.browser.opera')
  if (/SamsungBrowser\//.test(userAgent)) return t('security.browser.samsung')
  if (/(?:Firefox|FxiOS)\//.test(userAgent)) return t('security.browser.firefox')
  if (/(?:Chrome|CriOS)\//.test(userAgent)) return t('security.browser.chrome')
  if (/Safari\//.test(userAgent)) return t('security.browser.safari')
  return t('security.unknownBrowser')
}

/**
 * Render revocable browser devices and explicit credential rotations.
 * @param props - locale and authenticated action callbacks.
 * @returns security section with a recovery link after global logout.
 */
export function BrowserSecuritySection({ t, load, change }: Props) {
  const [state, setState] = useState<BrowserSecurityState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(false)
  const [loginUrl, setLoginUrl] = useState('')
  const [signedOut, setSignedOut] = useState(false)
  const [revision, setRevision] = useState(0)
  const [menuId, setMenuId] = useState<string>()
  const [editingId, setEditingId] = useState<string>()
  const [detailsId, setDetailsId] = useState<string>()
  const [advanced, setAdvanced] = useState(false)
  const [maintenance, setMaintenance] = useState(false)
  const sectionId = useId()
  useEffect(() => {
    if (signedOut) return
    const abort = new AbortController()
    void load(abort.signal).then(setState, (failure: unknown) => {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '')
    })
    return () => { abort.abort() }
  }, [load, revision, signedOut])

  const run = async (action: string, fields?: Parameters<BrowserSecurityActions['change']>[1]) => {
    setBusy(true)
    setError('')
    setNotice(false)
    try {
      const result = await change(action, fields)
      setSignedOut(result.signedOut)
      if (result.loginUrl !== undefined) setLoginUrl(result.loginUrl)
      setNotice(true)
      setRevision(value => value + 1)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '')
      return false
    } finally { setBusy(false) }
  }
  const confirm = (action: ConfirmAction, fields?: Parameters<BrowserSecurityActions['change']>[1]) => {
    if (window.confirm(t(`security.confirm.${action}`))) void run(action, fields)
  }
  return (
    <section className={css.section}>
      <header className={css.header}>
        <div>
          <h3>{t('security.nav')}</h3>
          <p className={css.muted}>{t('security.description')}</p>
        </div>
        {!signedOut && <Button variant="outline" size="sm" disabled={busy} onClick={() => { setRevision(value => value + 1) }}>{t('security.refresh')}</Button>}
      </header>
      {error !== '' && <p role="alert">{t('security.error')} {error}</p>}
      {notice && <p role="status">{signedOut ? t('security.signedOut') : t('security.done')}</p>}
      {loginUrl !== '' && (
        <div className={css.recovery}>
          <p>{t('security.keepLink')}</p>
          <a href={loginUrl} referrerPolicy="no-referrer">{t('security.login')}</a>
          <Input readOnly value={loginUrl} aria-label={t('security.loginUrl')} onFocus={(event) => { event.currentTarget.select() }} />
        </div>
      )}
      {!signedOut && (
        <fieldset disabled={busy} className={css.controls}>
          {state === undefined && <p>{t('security.loading')}</p>}
          {state?.sessions.map(device => (
            <article key={device.id} className={css.device}>
              <div className={css.deviceRow}>
                <div className={css.deviceSummary}>
                  <div className={css.deviceTitle}>
                    <strong>{device.name || t('security.unnamed')}</strong>
                    {device.current && <span className={css.badge}>{t('security.current')}</span>}
                  </div>
                  <p className={css.muted}>{browserName(device.userAgent, t)}</p>
                  <p className={css.muted}>{t('security.lastSeen')} · {new Date(device.lastSeenAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</p>
                </div>
                <Menu
                  open={menuId === device.id}
                  portal autoFocus align="end"
                  anchor={<Button variant="outline" size="sm" aria-haspopup="menu" aria-expanded={menuId === device.id} onClick={() => { setMenuId(menuId === device.id ? undefined : device.id) }}>{t('security.more')}</Button>}
                  items={[
                    { id: 'rename', label: t('security.editName'), disabled: busy },
                    { id: 'details', label: t('security.details'), disabled: busy },
                    { id: 'revoke', label: t('security.revoke'), danger: true, disabled: busy },
                  ]}
                  onClose={() => { setMenuId(undefined) }}
                  onSelect={(action) => {
                    setMenuId(undefined)
                    if (action === 'rename') setEditingId(device.id)
                    if (action === 'details') setDetailsId(device.id)
                    if (action === 'revoke') {
                      if (device.current) confirm('logout')
                      else confirm('revoke', { id: device.id })
                    }
                  }}
                />
              </div>
              {editingId === device.id && <form onSubmit={(event) => {
                event.preventDefault()
                const name = new FormData(event.currentTarget).get('name')
                if (typeof name === 'string') void run('rename', { id: device.id, name }).then((saved) => {
                  if (saved) setEditingId(undefined)
                })
              }}>
                <Input name="name" defaultValue={device.name} maxLength={100} required aria-label={t('security.deviceName')} />
                <Button variant="outline" type="submit">{t('security.rename')}</Button>
                <Button variant="outline" onClick={() => { setEditingId(undefined) }}>{t('security.cancel')}</Button>
              </form>}
              {detailsId === device.id && <div className={css.details}>
                <p className={css.agent}>{device.userAgent || t('security.unknownBrowser')}</p>
                <dl>
                  <dt>{t('security.created')}</dt><dd>{new Date(device.createdAt).toLocaleString()}</dd>
                  <dt>{t('security.lastSeen')}</dt><dd>{new Date(device.lastSeenAt).toLocaleString()}</dd>
                  <dt>{t('security.expires')}</dt><dd>{new Date(device.expiresAt).toLocaleString()}</dd>
                </dl>
                <p className={css.muted}>{t('security.deviceNote')}</p>
                <Button variant="outline" size="sm" onClick={() => { setDetailsId(undefined) }}>{t('security.hideDetails')}</Button>
              </div>}
            </article>
          ))}
          <div className={css.actions}>
            <Button variant="outline" disabled={!state?.sessions.some(device => !device.current)} onClick={() => { confirm('revoke-others') }}>{t('security.revokeOthers')}</Button>
          </div>
          <div className={css.advanced}>
            <Button variant="outline" aria-expanded={advanced} aria-controls={`${sectionId}-advanced`} onClick={() => { setAdvanced(value => !value) }}>{t('security.advanced')}</Button>
            {advanced && <div id={`${sectionId}-advanced`} className={css.advancedBody}>
              <div className={css.securityAction}>
                <p className={css.muted}>{t('security.cookieHint')}</p>
                <Button variant="outline" onClick={() => { confirm('rotate-cookie') }}>{t('security.rotateCookie')}</Button>
              </div>
              <div className={css.securityAction}>
                <p className={css.muted}>{t('security.tokenHint')}</p>
                <Button variant="outline" onClick={() => { confirm('rotate-token') }}>{t('security.rotateToken')}</Button>
              </div>
              <div className={css.securityAction}>
                <p className={css.muted}>{t('security.globalWarning')}</p>
                <Button variant="outline" className={css.danger} onClick={() => { confirm('logout-all') }}>{t('security.logoutAll')}</Button>
              </div>
              <div>
                <Button variant="outline" aria-expanded={maintenance} aria-controls={`${sectionId}-maintenance`} onClick={() => { setMaintenance(value => !value) }}>{t('security.maintenance')}</Button>
                {maintenance && <div id={`${sectionId}-maintenance`} className={css.securityAction}>
                  <p className={css.muted}>{t('security.keyHint')}</p>
                  <Button variant="outline" className={css.danger} onClick={() => { confirm('rotate-key') }}>{t('security.rotateKey')}</Button>
                </div>}
              </div>
            </div>}
          </div>
        </fieldset>
      )}
    </section>
  )
}
