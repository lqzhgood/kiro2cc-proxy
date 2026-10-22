import type { AddCredentialRequest } from '@/types/api'

export type InputErrorCode = 'invalidJson' | 'invalidShape' | 'missingToken' | 'invalidField' | 'invalidAuth' | 'tooLarge'

export class ImportInputError extends Error {
  readonly code: InputErrorCode
  constructor(code: InputErrorCode) {
    super(code)
    this.code = code
  }
}

const stringFields = ['email', 'clientId', 'clientSecret', 'profileArn', 'authRegion', 'apiRegion', 'machineId'] as const

/** Only the local export contract is accepted; never forward arbitrary JSON to the API. */
export function parseAccounts(text: string): AddCredentialRequest[] {
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new ImportInputError('tooLarge')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new ImportInputError('invalidJson') }
  const accounts = Array.isArray(parsed) ? parsed : [parsed]
  if (accounts.length === 0) throw new ImportInputError('invalidShape')
  return accounts.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImportInputError('invalidShape')
    const input = value as Record<string, unknown>
    if (typeof input.refreshToken !== 'string' || !input.refreshToken.trim()) throw new ImportInputError('missingToken')
    const account: AddCredentialRequest = { refreshToken: input.refreshToken.trim(), disabled: true, priority: 0 }
    for (const field of stringFields) {
      if (input[field] == null) continue
      if (typeof input[field] !== 'string') throw new ImportInputError('invalidField')
      account[field] = input[field].trim() || undefined
    }
    if (Boolean(account.clientId) !== Boolean(account.clientSecret)) throw new ImportInputError('invalidAuth')
    account.authMethod = account.clientId ? 'idc' : 'social'
    if (input.authMethod != null && (typeof input.authMethod !== 'string' || input.authMethod.toLowerCase() !== account.authMethod)) {
      throw new ImportInputError('invalidAuth')
    }
    if (input.provider != null) {
      if (typeof input.provider !== 'string') throw new ImportInputError('invalidField')
      account.provider = ({ google: 'Google', github: 'GitHub', enterprise: 'Enterprise' } as Record<string, string>)[input.provider.toLowerCase()]
    }
    return account
  })
}
