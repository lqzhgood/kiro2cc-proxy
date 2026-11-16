import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Braces, FolderOpen, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAddCredential, useCredentials, useSetDisabled } from '@/hooks/use-credentials'
import { getCredentialBalance } from '@/api/credentials'
import { sha256Hex } from '@/lib/hash'
import { importAccounts, type ImportResult } from '@/features/one-click-import/import-accounts'
import { JsonImportError, MAX_IMPORT_BYTES, parseJsonAccounts } from './parse'
import { example, messages } from './messages'

export function JsonImport({ className }: { className?: string }) {
  const { i18n } = useTranslation()
  const text = messages[i18n.language.startsWith('en') ? 'en' : 'zh']
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className={className} onClick={() => setOpen(true)} aria-label={text.title}>
      <Braces /><span>{text.title}</span>
    </button>
    {open && <ImportDialog onClose={() => setOpen(false)} />}
  </>
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { i18n } = useTranslation()
  const text = messages[i18n.language.startsWith('en') ? 'en' : 'zh']
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [finished, setFinished] = useState(false)
  const [labels, setLabels] = useState<string[]>([])
  const [results, setResults] = useState<ImportResult[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const alive = useRef(false)
  const { data: credentials } = useCredentials()
  const { mutateAsync: add } = useAddCredential()
  const { mutateAsync: setDisabled } = useSetDisabled()
  const locked = reading || importing

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const readFile = async (file?: File) => {
    if (!file || busy.current || finished) return
    setError('')
    if (!/\.json$/i.test(file.name)) { setError(text.invalidFile); return }
    if (file.size > MAX_IMPORT_BYTES) { setError(text.tooLarge); return }
    busy.current = true
    setReading(true)
    try {
      const value = await file.text()
      if (alive.current) setInput(value)
    } catch {
      if (alive.current) setError(text.fileReadFailed)
    } finally {
      busy.current = false
      if (alive.current) setReading(false)
    }
  }

  const submit = async () => {
    if (busy.current || finished) return
    let accounts
    try { accounts = parseJsonAccounts(input) } catch (failure) {
      const problem = failure instanceof JsonImportError ? failure : new JsonImportError('invalidJson')
      setError(`${problem.index ? `${text.account} ${problem.index} · ` : ''}${problem.field ? `${problem.field}: ` : ''}${text[problem.code]}`)
      return
    }
    busy.current = true
    setImporting(true)
    setError('')
    setLabels(accounts.map(account => [account.nickname, account.email].filter(Boolean).join(' · ')))
    await importAccounts(accounts, credentials?.credentials.flatMap(c => c.refreshTokenHash ? [c.refreshTokenHash] : []) ?? [], {
      add, verify: getCredentialBalance,
      enable: id => setDisabled({ id, disabled: false }), hash: sha256Hex,
    }, result => { if (alive.current) setResults(previous => [...previous, result]) })
    if (!alive.current) return
    busy.current = false
    setInput('')
    setImporting(false)
    setFinished(true)
  }

  return <Dialog open onOpenChange={value => { if (!value && !busy.current) onClose() }}>
    <DialogContent className="flex max-w-2xl max-h-[90dvh] flex-col overflow-hidden" onEscapeKeyDown={event => { if (locked) event.preventDefault() }} onPointerDownOutside={event => { if (locked) event.preventDefault() }}>
      <DialogHeader>
        <DialogTitle>{text.title}</DialogTitle>
        <DialogDescription>{text.description}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="json-import-data" className="text-sm font-semibold">{text.input}</label>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={locked || finished} onClick={() => fileInput.current?.click()}><FolderOpen className="h-4 w-4" />{text.file}</Button>
            <Button type="button" variant="outline" size="sm" disabled={locked || finished || !input} onClick={() => { setInput(''); setError('') }}>{text.clear}</Button>
          </div>
        </div>
        <input ref={fileInput} type="file" accept=".json,application/json" aria-label={text.file} className="hidden" disabled={locked || finished} onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          void readFile(file)
        }} />
        <textarea id="json-import-data" value={input} onChange={event => { setInput(event.target.value); setError('') }} disabled={locked || finished} autoComplete="off" spellCheck={false} rows={13} placeholder={example} aria-invalid={Boolean(error)} aria-describedby={error ? 'json-import-error' : 'json-import-hint'} className="w-full rounded-md border border-hairline-2 bg-surface-2 p-3 font-mono text-xs leading-relaxed focus-visible:outline-brand disabled:opacity-60" />
        <p id="json-import-hint" className="text-xs text-ink-3">{text.hint}</p>
        {error && <p id="json-import-error" role="alert" className="text-sm text-danger">{error}</p>}
        {locked && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{reading ? text.reading : `${text.importing}… ${results.length}/${labels.length}`}</p>}
        {results.length > 0 && <ul aria-live="polite" className="space-y-2 rounded-md bg-surface-2 p-3 text-sm">
          {results.map(result => <li key={result.index} className="break-words">{text.account} {result.index}{labels[result.index - 1] ? ` · ${labels[result.index - 1]}` : ''}{result.credentialId != null ? ` (#${result.credentialId})` : ''}：{text[result.status]}</li>)}
        </ul>}
        <p className="text-xs text-ink-3">{text.rules}</p>
      </div>
      <DialogFooter className="shrink-0 gap-2 sm:space-x-0">
        <Button type="button" variant="outline" disabled={locked} onClick={onClose}>{finished ? text.close : text.cancel}</Button>
        {!finished && <Button type="button" disabled={locked || !input.trim()} onClick={() => void submit()}>{text.confirm}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
