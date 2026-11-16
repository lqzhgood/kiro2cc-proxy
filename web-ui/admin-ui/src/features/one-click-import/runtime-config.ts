import { storage } from '@/lib/storage'
import type { ImportResult } from './import-accounts'

export interface ImportSession { token: string; expiresIn: number }
export type SessionResult = { status: 'awaiting' | 'running' } | Omit<ImportResult, 'index'>

export async function createImportSession(signal: AbortSignal): Promise<ImportSession> {
  const response = await fetch('/api/admin/fork/import-sessions', {
    method: 'POST', signal, cache: 'no-store',
    headers: { 'x-api-key': storage.getApiKey() ?? '' },
  })
  if (!response.ok) throw new Error('Import authorization unavailable')
  const value = await response.json()
  if (!value || !/^[a-f0-9]{64}$/.test(value.token) || value.expiresIn !== 600) throw new Error('Invalid import authorization')
  return value
}

export async function getImportStatus(token: string, signal: AbortSignal): Promise<SessionResult | null> {
  const response = await fetch('/api/admin/fork/import-session', {
    signal, cache: 'no-store', headers: { 'x-kiro-import-token': token },
  })
  if (response.status === 401) return null
  if (!response.ok) throw new Error('Import status unavailable')
  const value = await response.json()
  if (!value || !['awaiting', 'running', 'success', 'duplicate', 'failed', 'unverified', 'activationUnknown'].includes(value.status)) throw new Error('Invalid import status')
  return value
}
