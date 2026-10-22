import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardPaste, Copy, Download, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAddCredential, useCredentials, useSetDisabled } from '@/hooks/use-credentials'
import { getCredentialBalance } from '@/api/credentials'
import { sha256Hex } from '@/lib/hash'
import { ImportInputError, parseAccounts } from './parse'
import { importAccounts, type ImportResult } from './import-accounts'
import { messages } from './messages'
import { loadExportCommand } from './runtime-config'

export function OneClickImport({ className }: { className?: string }) {
  const { i18n } = useTranslation()
  const text = messages[i18n.language.startsWith('en') ? 'en' : 'zh']
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className={className} onClick={() => setOpen(true)} aria-label={text.title}>
      <Download /><span>{text.title}</span>
    </button>
    {/* Unmount on close: credentials and pending clipboard reads cannot survive a session. */}
    {open && <ImportDialog onClose={() => setOpen(false)} />}
  </>
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { i18n } = useTranslation()
  const text = messages[i18n.language.startsWith('en') ? 'en' : 'zh']
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const revision = useRef(0)
  const alive = useRef(false)
  const reading = useRef(false)
  const autoReadBlocked = useRef(false)
  const busy = useRef(false)
  const [importing, setImporting] = useState(false)
  const [finished, setFinished] = useState(false)
  const [results, setResults] = useState<ImportResult[]>([])
  const [notice, setNotice] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const [command, setCommand] = useState('')
  const [configStatus, setConfigStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const [error, setError] = useState('')
  const commandRef = useRef<HTMLTextAreaElement>(null)
  const { data: credentials } = useCredentials()
  const { mutateAsync: add } = useAddCredential()
  const { mutateAsync: setDisabled } = useSetDisabled()

  useEffect(() => {
    const controller = new AbortController()
    void loadExportCommand(controller.signal).then(value => {
      if (controller.signal.aborted) return
      setCommand(value ?? '')
      setConfigStatus(value ? 'ready' : 'missing')
    }).catch(() => {
      if (!controller.signal.aborted) setConfigStatus('error')
    })
    return () => controller.abort()
  }, [])

  const changeInput = useCallback((value: string) => {
    revision.current++
    inputRef.current = value
    setInput(value)
    setError('')
    setNotice('')
  }, [])

  const paste = useCallback(async (manual = false) => {
    if (busy.current || reading.current || (!manual && autoReadBlocked.current)) return
    if (inputRef.current.trim()) {
      if (manual) setNotice(text.kept)
      return
    }
    if (!window.isSecureContext || !navigator.clipboard?.readText) {
      autoReadBlocked.current = true
      setNotice(text.manualOnly)
      return
    }
    const startedAt = revision.current
    reading.current = true
    try {
      const value = await navigator.clipboard.readText()
      if (!alive.current || busy.current || revision.current !== startedAt) return
      try { parseAccounts(value) } catch {
        if (manual) setNotice(text.clipboardInvalid)
        return
      }
      changeInput(value)
      autoReadBlocked.current = false
      setNotice(text.filled)
    } catch {
      if (alive.current && revision.current === startedAt) {
        autoReadBlocked.current = true
        setNotice(text.clipboardUnavailable)
      }
    } finally { reading.current = false }
  }, [changeInput, text])

  useEffect(() => {
    alive.current = true
    const onFocus = () => { if (document.visibilityState === 'visible') void paste() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    // A focus event may not fire when a dialog opens within an already focused tab.
    if (document.hasFocus()) void paste()
    return () => {
      alive.current = false
      revision.current++
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [paste])

  const copyCommand = async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      if (alive.current) setCopyNotice(text.copied)
    } catch {
      commandRef.current?.select()
      if (alive.current) setCopyNotice(text.copyFailed)
    }
  }

  const submit = async () => {
    if (busy.current || finished) return
    let accounts
    try { accounts = parseAccounts(inputRef.current) } catch (failure) {
      setError(text[failure instanceof ImportInputError ? failure.code : 'invalidJson'])
      return
    }
    busy.current = true
    revision.current++
    setImporting(true)
    setError('')
    setNotice('')
    await importAccounts(accounts, credentials?.credentials.flatMap(c => c.refreshTokenHash ? [c.refreshTokenHash] : []) ?? [], {
      add, verify: getCredentialBalance,
      enable: id => setDisabled({ id, disabled: false }), hash: sha256Hex,
    }, result => { if (alive.current) setResults(previous => [...previous, result]) })
    if (!alive.current) return
    changeInput('')
    setImporting(false)
    setFinished(true)
    // Keep busy until the dialog closes so clipboard events cannot refill a completed import.
  }

  return <Dialog open onOpenChange={value => { if (!value && !importing) onClose() }}>
    <DialogContent className="flex max-w-2xl max-h-[90dvh] flex-col overflow-hidden" onEscapeKeyDown={event => { if (importing) event.preventDefault() }} onPointerDownOutside={event => { if (importing) event.preventDefault() }}>
      <DialogHeader className="shrink-0">
        <DialogTitle>{text.title}</DialogTitle>
        <DialogDescription>{text.description}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{text.step1}</h3>
            <span className="rounded bg-surface-3 px-2 py-1 text-xs text-ink-3">{text.macOnly}</span>
          </div>
          <p className="text-xs leading-relaxed text-ink-3">{text.commandHint}</p>
          <textarea ref={commandRef} aria-label={text.step1} value={command} placeholder={configStatus === 'loading' ? text.configLoading : text.configMissing} readOnly spellCheck={false} rows={6} className="w-full resize-none rounded-md border border-hairline-2 bg-surface-2 p-3 font-mono text-xs leading-relaxed sm:h-24" />
          <Button type="button" variant="outline" size="sm" disabled={!command} onClick={() => void copyCommand()}><Copy className="mr-2 h-4 w-4" />{text.copy}</Button>
          {configStatus === 'missing' && <p role="status" className="text-xs text-ink-3">{text.configMissing}</p>}
          {configStatus === 'error' && <p role="status" className="text-xs text-ink-3">{text.configError}</p>}
          {copyNotice && <p role="status" className="text-xs text-ink-3">{copyNotice}</p>}
        </section>
        <section className="space-y-2">
          <label htmlFor="one-click-import-data" className="block text-sm font-semibold">{text.step2}</label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={importing || finished} onClick={() => void paste(true)}><ClipboardPaste className="mr-2 h-4 w-4" />{text.paste}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={importing || finished} onClick={() => changeInput('')}>{text.clear}</Button>
          </div>
          <textarea id="one-click-import-data" value={input} onChange={event => changeInput(event.target.value)} disabled={importing || finished} autoComplete="off" spellCheck={false} rows={7} placeholder={text.placeholder} aria-invalid={Boolean(error)} aria-describedby={error ? 'one-click-import-error' : 'one-click-import-hint'} className="w-full rounded-md border border-hairline-2 bg-surface-2 p-3 font-mono text-xs leading-relaxed focus-visible:outline-brand disabled:opacity-60" />
          <p id="one-click-import-hint" className="text-xs text-ink-3">{text.clipboardHint}</p>
          {notice && <p role="status" className="text-xs text-ink-3">{notice}</p>}
          {error && <p id="one-click-import-error" role="alert" className="text-xs text-danger">{error}</p>}
        </section>
        {importing && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{text.importing}</p>}
        {results.length > 0 && <ul aria-live="polite" className="space-y-2 rounded-md bg-surface-2 p-3 text-sm">
          {results.map(result => <li key={result.index}>{text.account} {result.index}{result.credentialId != null ? ` (#${result.credentialId})` : ''}：{text[result.status]}</li>)}
        </ul>}
        <p className="text-xs text-ink-3">{text.privacy}</p>
      </div>
      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" disabled={importing} onClick={onClose}>{finished ? text.close : text.cancel}</Button>
        {!finished && <Button type="button" disabled={importing || !input.trim()} onClick={() => void submit()}>{text.confirm}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
