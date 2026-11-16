import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAccounts } from '../../web-ui/admin-ui/src/features/one-click-import/parse.ts'
import { importAccounts } from '../../web-ui/admin-ui/src/features/one-click-import/import-accounts.ts'
import { buildImportCommand } from '../../web-ui/admin-ui/src/features/one-click-import/command.ts'

const social = { refreshToken: 'test-only-social-token', authMethod: 'social', profileArn: 'arn:aws:test:profile', email: 'test@example.invalid', authRegion: 'us-east-1', apiRegion: 'us-east-1' }
const idc = { ...social, authMethod: 'idc', clientId: 'test-client', clientSecret: 'test-secret', machineId: 'a'.repeat(64) }

const grant = 'a'.repeat(64)
test('commands derive script and upload destinations from the page origin, including port', () => {
  for (const os of ['macos', 'windows']) {
    const command = buildImportCommand('https://example.invalid:8443/admin/?ignored=yes', grant, os)
    assert.ok(command.includes(`https://example.invalid:8443/api/admin/fork/scripts/${os}`))
    assert.ok(command.includes("'https://example.invalid:8443'"))
    assert.ok(command.includes(grant))
    assert.ok(!command.includes('ignored'))
    assert.ok(!command.includes('--stdout'))
  }
  assert.ok(buildImportCommand('http://localhost:5678', grant, 'macos').includes('bash -c'))
  assert.ok(buildImportCommand('https://example.invalid', grant, 'windows').includes('MaximumRedirection 0'))
})

test('commands reject unsafe URLs and grants before constructing shell code', () => {
  for (const value of ['', 'file:///tmp/a', 'javascript:alert(1)', 'https://u:p@example.invalid/a']) {
    assert.equal(buildImportCommand(value, grant, 'macos'), null)
  }
  for (const token of ['', 'x'.repeat(64), "$(id)", "a'bad"]) {
    assert.equal(buildImportCommand('https://example.invalid', token, 'windows'), null)
  }
})

test('accepts the script social/idc arrays, trims fields, and preserves API fields', () => {
  const accounts = parseAccounts(JSON.stringify([social, idc]))
  assert.equal(accounts[0].authMethod, 'social')
  assert.equal(accounts[1].authMethod, 'idc')
  assert.equal(accounts[1].machineId, idc.machineId)
  assert.equal(accounts[1].apiRegion, 'us-east-1')
  assert.equal(parseAccounts('{"refreshToken":" token "}')[0].refreshToken, 'token')
})

test('rejects irrelevant clipboard text, malformed/empty arrays and invalid credential fields', () => {
  for (const value of ['curl something', 'null', '[]', '[null]', '[1]', '{}', '{"accounts":[]}', '{"refreshToken":" "}', '{"refreshToken":123}', '{"refreshToken":"t","email":{}}', '{"refreshToken":"t","clientId":"id"}', '{"refreshToken":"t","authMethod":"idc"}', '{"refreshToken":"t","authMethod":"external_idp"}']) {
    assert.throws(() => parseAccounts(value), { name: 'Error' }, value)
  }
  assert.throws(() => parseAccounts('x'.repeat(2 * 1024 * 1024 + 1)), /tooLarge/)
})

test('does not allow payloads to enable accounts or set arbitrary server fields', () => {
  const account = parseAccounts(JSON.stringify({ ...social, disabled: false, proxyUrl: 'https://invalid.example', priority: 99 }))[0]
  assert.equal(account.disabled, true)
  assert.equal(account.priority, 0)
  assert.equal(account.proxyUrl, undefined)
})

function port(overrides = {}) {
  const calls = []
  return { calls, api: {
    hash: async token => token,
    add: async account => { calls.push(['add', account.disabled]); return { success: true, credentialId: 7 } },
    verify: async id => { calls.push(['verify', id]) },
    enable: async id => { calls.push(['enable', id]) },
    ...overrides,
  } }
}

test('creates disabled, verifies, enables and skips existing/in-batch duplicates', async () => {
  const { api, calls } = port()
  const updates = []
  const result = await importAccounts([social, social, { ...social, refreshToken: 'existing' }], ['existing'], api, r => updates.push(r.status))
  assert.deepEqual(calls, [['add', true], ['verify', 7], ['enable', 7]])
  assert.deepEqual(result.map(r => r.status), ['success', 'duplicate', 'duplicate'])
  assert.deepEqual(updates, ['success', 'duplicate', 'duplicate'])
})

test('failed verification preserves the disabled account and does not enable/recreate it', async () => {
  const { api, calls } = port({ verify: async () => { throw Error('test failure') } })
  const result = await importAccounts([social, social], [], api, () => {})
  assert.deepEqual(result.map(r => r.status), ['unverified', 'duplicate'])
  assert.equal(result[0].credentialId, 7)
  assert.deepEqual(calls, [['add', true]])
})

test('failed activation distinguishes a created account from failed creation', async () => {
  const { api } = port({ enable: async () => { throw Error('test failure') } })
  const [result] = await importAccounts([social], [], api, () => {})
  assert.equal(result.status, 'activationUnknown')
  assert.equal(result.credentialId, 7)
})

test('failed creation never verifies or enables and does not expose server response text', async () => {
  const { api, calls } = port({ add: async () => { throw Error('secret-token-in-response') } })
  const [result] = await importAccounts([social], [], api, () => {})
  assert.equal(result.status, 'failed')
  assert.deepEqual(calls, [])
  assert.ok(!JSON.stringify(result).includes('secret-token'))
})
