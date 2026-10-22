import { storage } from '@/lib/storage'
import { buildExportCommand } from './command'

export async function loadExportCommand(signal: AbortSignal): Promise<string | null> {
  const response = await fetch('/api/admin/fork/import-config', {
    signal,
    cache: 'no-store',
    headers: { 'x-api-key': storage.getApiKey() ?? '' },
  })
  if (!response.ok) throw new Error('Import configuration unavailable')
  const config: unknown = await response.json()
  if (!config || typeof config !== 'object' || !('scriptUrl' in config)) throw new Error('Invalid import configuration')
  return buildExportCommand(config.scriptUrl)
}
