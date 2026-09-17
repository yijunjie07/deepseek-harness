/** Real Web composition: device revocation, live socket cutoff, and recoverable global rotation. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

it('manages browser sessions through the shipped settings plugins', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./browser-security.overlay.yml', import.meta.url)),
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    // The scaffold's readiness probe creates its own session; retire it before counting browser devices.
    const probeLogout = await scaffold.hostFetch('/api/browser-security', {
      method: 'POST', headers: { origin: scaffold.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    })
    expect(probeLogout.status).toBe(200)
    browser = await chromium.launch()
    const first = await browser.newContext({ locale: 'zh-CN' })
    const second = await browser.newContext({ locale: 'zh-CN' })
    const page = await first.newPage()
    const other = await second.newPage()
    let liveSockets = 0
    let closedSockets = 0
    other.on('websocket', (socket) => {
      liveSockets += 1
      socket.on('close', () => { closedSockets += 1 })
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', (dialog) => { void dialog.accept() })
    await page.goto(scaffold.authenticatedUrl)
    await other.goto(scaffold.authenticatedUrl)
    await other.waitForSelector('[class*="frame"]')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '登录安全', exact: true }).click()
    await expect.poll(() => page.getByRole('article').count()).toBe(2)
    const buttons = await page.locator('fieldset').getByRole('button').allTextContents()
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/browser-security/controls.expected.md', import.meta.url)),
      buttons.join('\n'), webSnapshotMode(),
    )
    await page.getByRole('textbox', { name: '设备名称' }).first().fill('我的电脑')
    await page.getByRole('button', { name: '保存名称' }).first().click()
    await page.getByText('我的电脑', { exact: false }).first().waitFor()
    expect(liveSockets).toBeGreaterThan(0)
    const closedBeforeRevocation = closedSockets
    // Browser-authenticated HTTP proves revocation independently of the rendered row list.
    await page.getByRole('button', { name: '退出其他设备', exact: true }).click()
    await expect.poll(async () => (await second.request.get(`${scaffold.baseUrl}/api/browser-security`)).status()).toBe(401)
    await expect.poll(() => closedSockets).toBeGreaterThan(closedBeforeRevocation)
    await expect.poll(() => page.getByRole('article').count()).toBe(1)
    await page.getByRole('button', { name: '更新当前 Cookie', exact: true }).click()
    await expect.poll(async () => (await first.request.get(`${scaffold.baseUrl}/api/browser-security`)).status()).toBe(200)
    await page.getByRole('button', { name: '轮换全局签名密钥', exact: true }).click()
    const recovery = page.getByRole('link', { name: '重新登录', exact: true })
    await recovery.waitFor()
    expect((await first.request.get(`${scaffold.baseUrl}/api/browser-security`)).status()).toBe(401)
    const newUrl = await recovery.getAttribute('href')
    expect(newUrl).toContain('?token=')
    await recovery.click()
    await page.getByRole('button', { name: '设置', exact: true }).waitFor()
    expect((await first.request.get(`${scaffold.baseUrl}/api/browser-security`)).status()).toBe(200)
    expect(errors).toEqual([])
    await other.close()
  } finally {
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)
