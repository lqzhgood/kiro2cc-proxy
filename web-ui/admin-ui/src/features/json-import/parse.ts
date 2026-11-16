import type { AddCredentialRequest } from '@/types/api'

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024

export type InputErrorCode = 'invalidJson' | 'invalidShape' | 'invalidField' | 'missingToken' | 'invalidAuth' | 'invalidEmail' | 'invalidProvider' | 'tooLarge'

export class JsonImportError extends Error {
  readonly code: InputErrorCode
  readonly index?: number
  readonly field?: string

  constructor(code: InputErrorCode, index?: number, field?: string) {
    super(code)
    this.code = code
    this.index = index
    this.field = field
  }
}

const stringFields = ['refreshToken', 'nickname', 'email', 'clientId', 'clientSecret', 'profileArn', 'authRegion', 'apiRegion', 'provider'] as const

/** Validate the whole batch before any writes; forward only the agreed account fields. */
export function parseJsonAccounts(text: string): AddCredentialRequest[] {
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) throw new JsonImportError('tooLarge')
  let parsed: unknown
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new JsonImportError('invalidJson') }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new JsonImportError('invalidShape')
  return parsed.map((value: unknown, offset) => {
    const index = offset + 1
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JsonImportError('invalidShape', index)
    const input = value as Record<string, unknown>
    const account: AddCredentialRequest = { refreshToken: '', authMethod: 'social', disabled: true, priority: 0 }
    for (const field of stringFields) {
      if (input[field] === undefined) continue
      if (typeof input[field] !== 'string') throw new JsonImportError('invalidField', index, field)
      const trimmed = input[field].trim()
      if (trimmed) account[field] = trimmed
    }
    if (!account.refreshToken) throw new JsonImportError('missingToken', index, 'refreshToken')
    if (input.authMethod !== undefined) {
      if (input.authMethod !== 'social' && input.authMethod !== 'idc') throw new JsonImportError('invalidAuth', index, 'authMethod')
      account.authMethod = input.authMethod
    }
    if (account.authMethod === 'idc') {
      if (!account.clientId) throw new JsonImportError('invalidAuth', index, 'clientId')
      if (!account.clientSecret) throw new JsonImportError('invalidAuth', index, 'clientSecret')
    } else if (account.clientId || account.clientSecret) {
      throw new JsonImportError('invalidAuth', index, 'authMethod')
    }
    if (account.email && !/^[^\s@]+@[^\s@]+$/.test(account.email)) throw new JsonImportError('invalidEmail', index, 'email')
    if (account.provider) {
      if (!['Google', 'GitHub', 'Enterprise'].includes(account.provider)
        || (account.provider === 'Enterprise' ? account.authMethod !== 'idc' : account.authMethod !== 'social')) {
        throw new JsonImportError('invalidProvider', index, 'provider')
      }
    }
    return account
  })
}
