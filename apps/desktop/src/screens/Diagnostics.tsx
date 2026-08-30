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
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>
      <h1 className="mt-4 text-xl font-bold">Diagnostics</h1>
      <p className="mt-1 text-sm text-zinc-500">A quick health check of everything NodeDesk needs.</p>

      <div className="mt-6 divide-y divide-zinc-800/80 rounded-2xl border border-zinc-800 bg-zinc-900/40 px-5">
        {loading && (
          <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking…
          </div>
        )}
        {items.map((i) => (
          <div key={i.label} className="flex items-center justify-between py-3.5">
            <div>
              <p className="text-sm font-medium">{i.label}</p>
              {i.detail && <p className="mt-0.5 text-xs text-zinc-500">{i.detail}</p>}
            </div>
            {i.ok ? (
              <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> OK
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-sm font-medium text-red-400">
                <XCircle className="h-4 w-4" /> Problem
              </span>
            )}
          </div>
        ))}
      </div>

      <button
        onClick={exportReport}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 py-3 text-sm font-medium text-zinc-200 hover:bg-zinc-900"
      >
        <Download className="h-4 w-4" />
        Export diagnostic report
      </button>
      {exportPath && (
        <p className="mt-3 break-all rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-center text-xs text-zinc-400">
          Saved to <span className="font-mono text-zinc-200">{exportPath}</span>
        </p>
      )}
      <p className="mt-3 text-center text-[11px] text-zinc-600">
        Reports never contain passwords, private keys, tokens or clipboard contents.
      </p>
    </div>
  )
}
