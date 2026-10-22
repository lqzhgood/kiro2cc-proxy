/** The URL is runtime admin configuration, never a Vite/build-time constant. */
export function buildExportCommand(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null
  let url: URL
  try { url = new URL(value.trim()) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
  const quoted = `'${url.href.replace(/'/g, "'\\''")}'`
  return `kiro_script="$(curl -fsSL -- ${quoted})" && bash -c "$kiro_script" get-kiro-info.sh get --stdout`
}
