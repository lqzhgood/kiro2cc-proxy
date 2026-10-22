import type { AddCredentialRequest, AddCredentialResponse } from '@/types/api'

export type ImportResult = {
  index: number
  status: 'success' | 'duplicate' | 'failed' | 'unverified' | 'activationUnknown'
  credentialId?: number
}

export interface ImportPort {
  add: (account: AddCredentialRequest) => Promise<AddCredentialResponse>
  verify: (id: number) => Promise<unknown>
  enable: (id: number) => Promise<unknown>
  hash: (token: string) => Promise<string>
}

/** Keep the upstream create-disabled -> verify -> enable contract in one adapter. */
export async function importAccounts(
  accounts: AddCredentialRequest[],
  existingHashes: Iterable<string>,
  port: ImportPort,
  onResult: (result: ImportResult) => void,
): Promise<ImportResult[]> {
  const known = new Set(existingHashes)
  const results: ImportResult[] = []
  for (const [index, account] of accounts.entries()) {
    let result: ImportResult = { index: index + 1, status: 'failed' }
    try {
      const hash = await port.hash(account.refreshToken)
      if (known.has(hash)) {
        result.status = 'duplicate'
      } else {
        const added = await port.add({ ...account, disabled: true })
        if (!added.success || !Number.isSafeInteger(added.credentialId)) throw new Error('Invalid add response')
        known.add(hash)
        result.credentialId = added.credentialId
        result.status = 'unverified'
        await port.verify(added.credentialId)
        result.status = 'activationUnknown'
        await port.enable(added.credentialId)
        result.status = 'success'
      }
    } catch {
      // Do not put server errors containing credentials into the UI or logs.
      // A created account must not be reported as a failed creation or retried here.
    }
    results.push(result)
    onResult(result)
  }
  return results
}
