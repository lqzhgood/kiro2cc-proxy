import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'browser.spec.mjs',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4179/admin/',
    ...(process.env.KIRO_TEST_BROWSER ? { channel: process.env.KIRO_TEST_BROWSER } : {}),
  },
  webServer: {
    command: 'npm --prefix ../../web-ui/admin-ui run dev -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/admin/',
    reuseExistingServer: false,
    timeout: 60000,
  },
})
