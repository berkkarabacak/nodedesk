import { useEffect, useState } from 'react'
import { ArrowLeft, CheckCircle2, Download, Loader2, XCircle } from 'lucide-react'
import { api, type DiagnosticsItem } from '../lib/api'

export default function Diagnostics({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<DiagnosticsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [exportPath, setExportPath] = useState('')

  useEffect(() => {
    void api
      .runDiagnostics()
      .then(setItems)
      .finally(() => setLoading(false))
  }, [])

  const exportReport = () => {
    void api.exportDiagnostics().then(setExportPath)
  }

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-5 py-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-nd-dim hover:text-nd-text">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>
      <h1 className="mt-4 text-xl font-bold">Diagnostics</h1>
      <p className="mt-1 text-sm text-nd-dim">A quick health check of everything NodeDesk needs.</p>

      <div className="mt-6 divide-y divide-nd-rule rounded-2xl border border-nd-divider bg-nd-surface px-5">
        {loading && (
          <div className="flex items-center gap-2 py-4 text-sm text-nd-dim">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking…
          </div>
        )}
        {items.map((i) => (
          <div key={i.label} className="flex items-center justify-between py-3.5">
            <div>
              <p className="text-sm font-medium">{i.label}</p>
              {i.detail && <p className="mt-0.5 text-xs text-nd-dim">{i.detail}</p>}
            </div>
            {i.ok ? (
              <span className="flex items-center gap-1.5 text-sm font-medium text-nd-ok">
                <CheckCircle2 className="h-4 w-4" /> OK
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-sm font-medium text-nd-danger">
                <XCircle className="h-4 w-4" /> Problem
              </span>
            )}
          </div>
        ))}
      </div>

      <button
        onClick={exportReport}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-nd-divider py-3 text-sm font-medium text-nd-text hover:bg-nd-surface"
      >
        <Download className="h-4 w-4" />
        Export diagnostic report
      </button>
      {exportPath && (
        <p className="mt-3 break-all rounded-lg border border-nd-divider bg-nd-surface p-3 text-center text-xs text-nd-dim">
          Saved to <span className="font-mono text-nd-text">{exportPath}</span>
        </p>
      )}
      <p className="mt-3 text-center text-[11px] text-nd-dim">
        Reports never contain passwords, private keys, tokens or clipboard contents.
      </p>
    </div>
  )
}
