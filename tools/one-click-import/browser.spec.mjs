import { test, expect } from '@playwright/test'

const exported = JSON.stringify([{ refreshToken: 'fake-token-for-browser-test', authMethod: 'social', email: 'test@example.invalid', profileArn: 'arn:aws:test:profile', authRegion: 'us-east-1', apiRegion: 'us-east-1' }])
const scriptUrl = 'https://example.invalid/kiro/get-kiro-info.sh'

async function setup(page, { clipboard = 'not account data', denied = false, delayed = false, balanceFails = false, activationFails = false, unsupported = false, existingHashes = [], configUrl = scriptUrl, configFails = false } = {}) {
  const mutations = []
  await page.addInitScript(({ clipboard, denied, delayed, unsupported }) => {
    localStorage.setItem('adminPsw', 'test-only-api-key')
    localStorage.setItem('admin-lang', 'zh')
    window.testClipboard = { text: clipboard, denied, delayed, reads: 0, writes: [], resolve: null }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: unsupported ? undefined : {
      readText: async () => {
        const state = window.testClipboard
        state.reads++
        if (state.denied) throw new DOMException('Denied for test', 'NotAllowedError')
        if (state.delayed) return new Promise(resolve => { state.resolve = resolve })
        return state.text
      },
      writeText: async value => { window.testClipboard.writes.push(value) },
    } })
  }, { clipboard, denied, delayed, unsupported })
  await page.route('**/api/admin/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST') {
      mutations.push({ path, body: request.postDataJSON() })
      if (path.endsWith('/disabled') && activationFails) {
        await route.fulfill({ status: 500, json: { error: { message: 'test activation error' } } })
      } else {
        await route.fulfill({ json: { success: true, credentialId: 41 } })
      }
    } else if (path.endsWith('/fork/import-config')) {
      expect(request.headers()['x-api-key']).toBe('test-only-api-key')
      await route.fulfill({ status: configFails ? 500 : 200, json: { scriptUrl: configUrl } })
    } else if (path.endsWith('/credentials')) {
      await route.fulfill({ json: { total: existingHashes.length, available: 0, currentId: 0, credentials: existingHashes.map((hash, i) => ({ id: i + 1, disabled: true, refreshTokenHash: hash, priority: 0, healthStatus: 'disabled', successCount: 0 })) } })
    } else if (path.endsWith('/balance')) {
      await route.fulfill({ status: balanceFails ? 500 : 200, json: balanceFails ? { error: { message: 'test verification error' } } : { id: 41, currentUsage: 0, usageLimit: 100, remaining: 100, usagePercentage: 0 } })
    } else if (path.includes('/api-keys') || path.includes('/usage/daily')) {
      await route.fulfill({ json: [] })
    } else {
      await route.fulfill({ json: {} })
    }
  })
  await page.goto('./')
  await expect(page.getByRole('button', { name: '一键导入', exact: true })).toBeVisible()
  return mutations
}

const input = page => page.getByLabel('2. 粘贴账户信息', { exact: true })
const open = page => page.getByRole('button', { name: '一键导入', exact: true }).click()
const focus = page => page.evaluate(() => window.dispatchEvent(new Event('focus')))

test('upstream action bar keeps the KAM button hidden and opens the isolated dialog', async ({ page }, testInfo) => {
  const requests = await setup(page)
  const oldButton = page.locator('button[aria-label="KAM导入账号"]')
  await expect(oldButton).toHaveCount(1)
  await expect(oldButton).toHaveCSS('display', 'none')
  await open(page)
  await expect(page.getByText('仅支持 macOS · 需要 jq 或 python3')).toBeVisible()
  await page.getByRole('button', { name: '复制命令', exact: true }).click()
  const [command] = await page.evaluate(() => window.testClipboard.writes)
  expect(command).toContain(scriptUrl)
  expect(command).toContain('get --stdout')
  await expect(input(page)).toHaveValue('')
  expect(requests).toEqual([])
  await expect(page.getByRole('button', { name: '确定导入', exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('dialog-desktop.png') })
})

for (const [state, options, message] of [
  ['missing', { configUrl: null }, /服务器尚未配置有效的脚本地址/],
  ['invalid', { configUrl: 'file:///tmp/export.sh' }, /服务器尚未配置有效的脚本地址/],
  ['unavailable', { configFails: true }, /无法获取导出命令/],
]) {
  test(`runtime configuration ${state} disables command copying but preserves manual import`, async ({ page }) => {
    const configRequests = []
    page.on('request', request => {
      if (request.url().endsWith('/fork/import-config')) configRequests.push(request)
    })
    await setup(page, options)
    expect(configRequests).toHaveLength(0)
    await open(page)
    await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()
    await expect(page.getByRole('button', { name: '复制命令', exact: true })).toBeDisabled()
    await expect(page.getByLabel('1. 在 Mac 终端执行', { exact: true })).toHaveValue('')
    await input(page).fill(exported)
    await page.getByRole('button', { name: '确定导入', exact: true }).click()
    await expect(page.getByText(/导入成功，已启用/)).toBeVisible()
  })
}

test('returning to the page fills valid JSON only inside the open dialog, without submitting', async ({ page }) => {
  const requests = await setup(page)
  await focus(page)
  expect(await page.evaluate(() => window.testClipboard.reads)).toBe(0)
  await open(page)
  await page.evaluate(value => { window.testClipboard.text = value }, exported)
  await focus(page)
  await expect(input(page)).toHaveValue(exported)
  await input(page).fill('my manual edits')
  await focus(page)
  await expect(input(page)).toHaveValue('my manual edits')
  expect(requests).toEqual([])
  await page.getByRole('button', { name: '取消', exact: true }).click()
  const reads = await page.evaluate(() => window.testClipboard.reads)
  await focus(page)
  expect(await page.evaluate(() => window.testClipboard.reads)).toBe(reads)
  await page.evaluate(() => { window.testClipboard.text = 'nothing' })
  await open(page)
  await expect(input(page)).toHaveValue('')
})

test('permission rejection stops automatic retries, but manual paste can retry', async ({ page }) => {
  await setup(page, { denied: true })
  await open(page)
  await focus(page)
  await expect(page.getByText(/浏览器未允许读取剪贴板/)).toBeVisible()
  const reads = await page.evaluate(() => window.testClipboard.reads)
  await focus(page)
  expect(await page.evaluate(() => window.testClipboard.reads)).toBe(reads)
  await page.evaluate(value => { window.testClipboard.denied = false; window.testClipboard.text = value }, exported)
  await page.getByRole('button', { name: '从剪贴板粘贴', exact: true }).click()
  await expect(input(page)).toHaveValue(exported)
})

test('a delayed clipboard response cannot overwrite typing or populate a later dialog', async ({ page }) => {
  await setup(page, { delayed: true })
  await open(page)
  await focus(page)
  await expect.poll(() => page.evaluate(() => Boolean(window.testClipboard.resolve))).toBe(true)
  await input(page).fill('typed while waiting')
  await page.evaluate(value => window.testClipboard.resolve(value), exported)
  await expect(input(page)).toHaveValue('typed while waiting')
  await page.getByRole('button', { name: '清空', exact: true }).click()
  await page.evaluate(() => { window.testClipboard.resolve = null })
  await focus(page)
  await expect.poll(() => page.evaluate(() => Boolean(window.testClipboard.resolve))).toBe(true)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.evaluate(value => { window.testClipboard.resolve(value); window.testClipboard.delayed = false; window.testClipboard.text = 'nothing' }, exported)
  await open(page)
  await expect(input(page)).toHaveValue('')
})

test('unsupported clipboard still permits manual input, validation, and explicit import', async ({ page }) => {
  const requests = await setup(page, { unsupported: true })
  await open(page)
  await focus(page)
  await expect(page.getByText(/当前浏览器无法读取剪贴板/)).toBeVisible()
  await input(page).fill('invalid JSON')
  await page.getByRole('button', { name: '确定导入', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText(/请输入有效的 JSON/)
  expect(requests).toEqual([])
  await input(page).fill(exported)
  await page.getByRole('button', { name: '确定导入', exact: true }).click()
  await expect(page.getByText(/导入成功，已启用/)).toBeVisible()
  expect(requests).toEqual([
    { path: '/api/admin/credentials', body: { ...JSON.parse(exported)[0], disabled: true, priority: 0 } },
    { path: '/api/admin/credentials/41/disabled', body: { disabled: false } },
  ])
  await expect(input(page)).toHaveValue('')
  await expect(page.getByRole('button', { name: '确定导入', exact: true })).toHaveCount(0)
  await focus(page)
  expect(requests).toHaveLength(2)
})

for (const [failure, options, message] of [
  ['verification', { balanceFails: true }, /已导入但验活失败/],
  ['activation', { activationFails: true }, /启用结果未确认/],
]) {
  test(`${failure} failure shows the existing account outcome and does not recreate it`, async ({ page }) => {
    const requests = await setup(page, options)
    await open(page)
    await input(page).fill(exported)
    await page.getByRole('button', { name: '确定导入', exact: true }).click()
    await expect(page.getByText(message)).toBeVisible()
    expect(requests.filter(r => r.path === '/api/admin/credentials')).toHaveLength(1)
    expect(requests.filter(r => r.path.endsWith('/disabled'))).toHaveLength(failure === 'verification' ? 0 : 1)
  })
}

test('dialog fits a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await open(page)
  await expect(page.getByLabel('1. 在 Mac 终端执行', { exact: true })).toHaveValue(new RegExp('example\\.invalid'))
  const box = await page.getByRole('dialog').boundingBox()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(844)
  await expect(page.getByRole('button', { name: '确定导入', exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('dialog-mobile.png') })
})
