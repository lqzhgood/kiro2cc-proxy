import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JsonImportError, MAX_IMPORT_BYTES, parseJsonAccounts } from '../../web-ui/admin-ui/src/features/json-import/parse.ts'
import { importAccounts } from '../../web-ui/admin-ui/src/features/one-click-import/import-accounts.ts'

const idc = {
  nickname: '工作账号', email: 'name@example.invalid', authMethod: 'idc', provider: 'Enterprise',
  refreshToken: 'test-only-token', clientId: 'test-client', clientSecret: 'test-secret',
  profileArn: 'arn:aws:test:profile', authRegion: 'us-east-1', apiRegion: 'us-west-2',
}
const parse = values => parseJsonAccounts(JSON.stringify(values))

test('JSON import preserves all agreed fields, trims text, and accepts UTF-8 BOM files', () => {
  const input = { ...idc, nickname: ' 工作账号 ', email: ' name@example.invalid ' }
  const [account] = parseJsonAccounts('\uFEFF' + JSON.stringify([input]))
  assert.deepEqual(account, { ...idc, disabled: true, priority: 0 })
  assert.deepEqual(parse([{ refreshToken: ' t ', nickname: ' ', email: '' }]), [
    { refreshToken: 't', authMethod: 'social', disabled: true, priority: 0 },
  ])
})

test('JSON import rejects malformed or oversized batches before any writes', () => {
  for (const input of ['', '{', 'null', '{}', '[]', '[null]', '[[]]', '[1]']) {
    assert.throws(() => parseJsonAccounts(input), JsonImportError)
  }
  // Multibyte text must be limited by bytes, not JS string length.
  assert.throws(() => parseJsonAccounts('中'.repeat(Math.floor(MAX_IMPORT_BYTES / 3) + 1)), { code: 'tooLarge' })
  assert.throws(() => parse([idc, { ...idc, clientSecret: '' }]), { code: 'invalidAuth', index: 2, field: 'clientSecret' })
})

test('JSON import reports row and field without exposing credential values', () => {
  for (const field of Object.keys(idc).filter(field => field !== 'authMethod')) {
    for (const value of [null, 123, false, [], { secret: 'never-display-this' }]) {
      assert.throws(() => parse([idc, { ...idc, [field]: value }]), error => {
        assert.equal(error.code, 'invalidField')
        assert.equal(error.index, 2)
        assert.equal(error.field, field)
        assert.ok(!JSON.stringify(error).includes('never-display-this'))
        return true
      })
    }
  }
  assert.throws(() => parse([{ ...idc, refreshToken: ' ' }]), { code: 'missingToken', field: 'refreshToken' })
  assert.throws(() => parse([{ ...idc, email: 'bad email' }]), { code: 'invalidEmail', field: 'email' })
})

test('JSON import validates auth method, client credentials and provider pairing', () => {
  for (const authMethod of [null, 1, '', 'IdC', 'external_idp', 'social', undefined]) {
    assert.throws(() => parse([{ ...idc, authMethod }]), { code: 'invalidAuth' })
  }
  for (const field of ['clientId', 'clientSecret']) {
    assert.throws(() => parse([{ ...idc, [field]: undefined }]), { code: 'invalidAuth', field })
  }
  for (const provider of ['GitHub', 'Google', 'unknown']) {
    assert.throws(() => parse([{ ...idc, provider }]), { code: 'invalidProvider' })
  }
  assert.throws(() => parse([{ refreshToken: 't', provider: 'Enterprise' }]), { code: 'invalidProvider' })
  for (const provider of ['Google', 'GitHub', undefined]) {
    assert.equal(parse([{ refreshToken: 't', provider }])[0].authMethod, 'social')
  }
})

test('JSON import ignores fields outside its contract and always creates disabled', () => {
  const [account] = parse([{ ...idc, disabled: false, priority: 99, proxyUrl: 'https://example.invalid',
    accessToken: 'not-used', expiresAt: 'not-used', clientIdHash: 'not-used', region: 'not-used' }])
  assert.deepEqual(account, { ...idc, disabled: true, priority: 0 })
})

test('JSON import passes names and regions to the API and continues after a failed account', async () => {
  const accounts = parse([idc, { ...idc, refreshToken: 'bad' }, { refreshToken: 'social' }, idc])
  const added = []
  const enabled = []
  const results = await importAccounts(accounts, [], {
    hash: async token => token,
    add: async account => {
      added.push(account)
      if (account.refreshToken === 'bad') throw Error('test-only-failure')
      return { success: true, credentialId: added.length }
    },
    verify: async () => {},
    enable: async id => { enabled.push(id) },
  }, () => {})
  assert.deepEqual(added[0], { ...idc, disabled: true, priority: 0 })
  assert.deepEqual(results.map(result => result.status), ['success', 'failed', 'success', 'duplicate'])
  assert.deepEqual(enabled, [1, 3])
})
