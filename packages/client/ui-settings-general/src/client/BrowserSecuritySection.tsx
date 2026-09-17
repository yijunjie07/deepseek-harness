/** Login-device controls; data and mutations arrive through the slot injection. */
import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserSecurityActions, BrowserSecurityState } from './browser-security-api.ts'
import css from './BrowserSecuritySection.module.css'

type Props = PropsRuntime<'settings.section'> & PropsLocale<'settings'> & BrowserSecurityActions

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
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '')
    } finally { setBusy(false) }
  }
  const confirm = (action: string, fields?: Parameters<BrowserSecurityActions['change']>[1]) => {
    if (window.confirm(t('security.confirm'))) void run(action, fields)
  }
  return (
    <section className={css.section}>
      <h3>{t('security.nav')}</h3>
      <p>{t('security.description')}</p>
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
          <div className={css.actions}>
            <Button onClick={() => { setRevision(value => value + 1) }}>{t('security.refresh')}</Button>
            <Button onClick={() => { confirm('revoke-others') }}>{t('security.revokeOthers')}</Button>
            <Button onClick={() => { confirm('rotate-cookie') }}>{t('security.rotateCookie')}</Button>
            <Button onClick={() => { confirm('rotate-token') }}>{t('security.rotateToken')}</Button>
          </div>
          {state === undefined && <p>{t('security.loading')}</p>}
          {state?.sessions.map(device => (
            <article key={device.id} className={css.device}>
              <strong>{device.name || t('security.unnamed')} {device.current && t('security.current')}</strong>
              <p className={css.agent}>{device.userAgent || t('security.unknownBrowser')}</p>
              <dl>
                <dt>{t('security.created')}</dt><dd>{new Date(device.createdAt).toLocaleString()}</dd>
                <dt>{t('security.lastSeen')}</dt><dd>{new Date(device.lastSeenAt).toLocaleString()}</dd>
                <dt>{t('security.expires')}</dt><dd>{new Date(device.expiresAt).toLocaleString()}</dd>
              </dl>
              <form onSubmit={(event) => {
                event.preventDefault()
                const name = new FormData(event.currentTarget).get('name')
                if (typeof name === 'string') void run('rename', { id: device.id, name })
              }}>
                <Input name="name" defaultValue={device.name} maxLength={100} required aria-label={t('security.deviceName')} />
                <Button type="submit">{t('security.rename')}</Button>
                <Button onClick={() => { confirm('revoke', { id: device.id }) }}>{t('security.revoke')}</Button>
              </form>
            </article>
          ))}
          <p>{t('security.globalWarning')}</p>
          <div className={css.actions}>
            <Button onClick={() => { confirm('logout') }}>{t('security.logout')}</Button>
            <Button onClick={() => { confirm('logout-all') }}>{t('security.logoutAll')}</Button>
            <Button onClick={() => { confirm('rotate-key') }}>{t('security.rotateKey')}</Button>
          </div>
        </fieldset>
      )}
    </section>
  )
}
