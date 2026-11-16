export type ImportPlatform = 'macos' | 'windows'

/** Derive both destinations from the page origin; never interpolate unquoted shell input. */
export function buildImportCommand(origin: string, token: string, platform: ImportPlatform): string | null {
  let url: URL
  try { url = new URL(origin) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^[a-f0-9]{64}$/.test(token)) return null
  const base = url.origin
  const script = `${base}/api/admin/fork/scripts/${platform}`
  if (platform === 'windows') {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
    return `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop -Uri ${quote(script)}).Content)) -ServerOrigin ${quote(base)} -ImportToken ${quote(token)}`
  }
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  return `kiro_script="$(curl -fsS -- ${quote(script)})" && bash -c "$kiro_script" get-kiro-info.sh get --server-origin ${quote(base)} --import-token ${quote(token)}`
}
