/** Real Web composition: device revocation, live socket cutoff, and recoverable global rotation. */
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    await page.getByRole('button', { name: '登录设备', exact: true }).click()
    await expect.poll(() => page.getByRole('article').count()).toBe(2)
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: '登录设备', exact: true }) })
    const buttons = await section.getByRole('button').allTextContents()
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/browser-security/controls.expected.md', import.meta.url)),
      buttons.join('\n'), webSnapshotMode(),
    )
    expect(await section.getByRole('textbox').count()).toBe(0)
    expect(await section.getByRole('button', { name: '更新本机登录凭证', exact: true }).count()).toBe(0)
    expect(await section.getByRole('button').evaluateAll(nodes => nodes.every((node) => {
      const style = getComputedStyle(node)
      return style.borderTopStyle === 'solid' && Number.parseFloat(style.borderTopWidth) > 0
    }))).toBe(true)
    const current = section.getByRole('article').filter({ hasText: '当前设备' })
    await current.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '查看详情', exact: true }).click()
    await current.getByText('登录时间', { exact: true }).waitFor()
    await current.getByRole('button', { name: '收起详情', exact: true }).click()
    expect(await current.getByText('登录时间', { exact: true }).count()).toBe(0)
    await current.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '修改名称', exact: true }).click()
    await current.getByRole('textbox', { name: '设备名称' }).fill('我的电脑')
    await current.getByRole('button', { name: '保存名称' }).click()
    await page.getByText('我的电脑', { exact: false }).first().waitFor()
    expect(liveSockets).toBeGreaterThan(0)
    const closedBeforeRevocation = closedSockets
    // Browser-authenticated HTTP proves revocation independently of the rendered row list.
    await page.getByRole('button', { name: '退出其他设备', exact: true }).click()
    await expect.poll(async () => (await second.request.get(`${scaffold.baseUrl}/api/browser-security`)).status()).toBe(401)
    await expect.poll(() => closedSockets).toBeGreaterThan(closedBeforeRevocation)
    await expect.poll(() => page.getByRole('article').count()).toBe(1)
    expect(await page.getByRole('button', { name: '退出其他设备', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: '高级安全', exact: true }).click()
    expect(await page.getByRole('button', { name: '更换全局签名密钥', exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/browser-security/advanced.expected.md', import.meta.url)),
      (await section.getByRole('button').allTextContents()).join('\n'), webSnapshotMode(),
    )
    await page.getByRole('button', { name: '更新本机登录凭证', exact: true }).click()
    await expect.poll(async () => (await first.request.get(`${scaffold.baseUrl}/api/browser-security`)).status()).toBe(200)
    await page.getByRole('button', { name: '更换登录链接', exact: true }).click()
    await page.getByRole('link', { name: '重新登录', exact: true }).waitFor()
    expect((await first.request.get(`${scaffold.baseUrl}/api/browser-security`)).status()).toBe(200)
    expect((await second.request.get(scaffold.authenticatedUrl)).status()).toBe(401)
    const tokenLink = await page.getByRole('link', { name: '重新登录', exact: true }).getAttribute('href')
    await page.getByRole('button', { name: '维护操作', exact: true }).click()
    await page.getByRole('button', { name: '更换全局签名密钥', exact: true }).click()
    const recovery = page.getByRole('link', { name: '重新登录', exact: true })
    await recovery.waitFor()
    await expect.poll(async () => (await first.request.get(`${scaffold.baseUrl}/api/browser-security`)).status()).toBe(401)
    await expect.poll(() => recovery.getAttribute('href')).not.toBe(tokenLink)
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

it('persists model settings from an authenticated non-loopback browser', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./browser-security.overlay.yml', import.meta.url)),
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const address = new URL(scaffold.authenticatedUrl)
    address.hostname = 'managed.dsh.test'
    browser = await chromium.launch({
      args: ['--host-resolver-rules=MAP managed.dsh.test 127.0.0.1', '--no-proxy-server'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(address.href)
    expect(new URL(page.url()).hostname).toBe('managed.dsh.test')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    expect(await dialog.getByRole('button', { name: '打开配置文件' }).count()).toBe(0)
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    const add = dialog.getByRole('button', { name: '添加提供方', exact: true })
    await expect.poll(() => add.isEnabled()).toBe(true)
    await add.click()
    await dialog.getByLabel('提供方', { exact: true }).selectOption('minimax-cn')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 minimax-cn。', { exact: true }).waitFor()
    expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('minimax-cn: {}')

    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByRole('button', { name: '编辑 minimax-cn', exact: true }).waitFor()
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/browser-security/remote-models.expected.md', import.meta.url)),
      (await dialog.getByRole('button', { name: /^(编辑|删除) minimax-cn$/ }).allTextContents()).join('\n'),
      webSnapshotMode(),
    )
    const logout = await page.evaluate(async () => (await fetch('/api/browser-security', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'logout' }),
    })).status)
    expect(logout).toBe(200)
    expect(await page.evaluate(async () => (await fetch('/api/settings/describe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status)).toBe(401)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
})
