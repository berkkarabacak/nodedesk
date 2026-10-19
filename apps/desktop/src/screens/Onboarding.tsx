import { useEffect, useState } from 'react'
import { MonitorSmartphone, MonitorCog, Layers, Check, Loader2, AlertTriangle } from 'lucide-react'
import { api, onEvent, type UsageMode } from '../lib/api'

const options: { mode: UsageMode; icon: typeof MonitorSmartphone; title: string; text: string; recommended?: boolean }[] = [
  {
    mode: 'controller',
    icon: MonitorSmartphone,
    title: 'Control my computers',
    text: 'Use this machine to reach your other desktops, laptops and workstations.',
  },
  {
    mode: 'host',
    icon: MonitorCog,
    title: 'Allow this computer to be controlled',
    text: 'Let your trusted devices connect to this machine’s desktop, files and terminal.',
  },
  {
    mode: 'both',
    icon: Layers,
    title: 'Both',
    text: 'Control other computers and allow this one to be controlled.',
    recommended: true,
  },
]

export default function Onboarding({ onDone }: { onDone: (mode: UsageMode) => void }) {
  const [mode, setMode] = useState<UsageMode>('both')
  const [phase, setPhase] = useState<'choose' | 'working' | 'error'>('choose')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      onEvent('bootstrap-progress', (msg) => setProgress(msg)),
      onEvent('bootstrap-done', () => onDone(mode)),
      onEvent('bootstrap-error', (msg) => {
        setError(msg)
        setPhase('error')
      }),
    ]
    return () => {
      unlisteners.forEach((u) => void u.then((fn) => fn()))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const start = async () => {
    setPhase('working')
    setProgress('Getting everything ready…')
    try {
      await api.completeOnboarding(mode)
    } catch (e) {
      setError(String(e))
      setPhase('error')
    }
  }

  const retry = async () => {
    setPhase('working')
    setError('')
    setProgress('Retrying host setup…')
    try {
      await api.bootstrapHost()
    } catch (e) {
      setError(String(e))
      setPhase('error')
    }
  }

  if (phase !== 'choose') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-nd-bg px-4">
        <div className="w-full max-w-md text-center">
          {phase === 'working' ? (
            <>
              <Loader2 className="mx-auto h-10 w-10 animate-spin text-nd-ok" />
              <h1 className="mt-6 text-xl font-bold">Setting up this computer</h1>
              <p className="mt-3 text-sm text-nd-dim">{progress}</p>
              <p className="mt-2 text-xs text-nd-dim">This can take a couple of minutes the first time.</p>
            </>
          ) : (
            <>
              <AlertTriangle className="mx-auto h-10 w-10 text-nd-danger" />
              <h1 className="mt-6 text-xl font-bold">Setup hit a snag</h1>
              <p className="mt-3 rounded-lg border border-nd-divider bg-nd-surface p-3 text-sm text-nd-dim">{error}</p>
              <div className="mt-6 flex gap-3">
                <button onClick={retry} className="flex-1 rounded-xl bg-nd-accent py-3 text-sm font-semibold text-nd-on-accent hover:brightness-110">
                  Try again
                </button>
                <button onClick={() => onDone(mode)} className="rounded-xl border border-nd-divider px-6 py-3 text-sm text-nd-text hover:bg-nd-surface">
                  Continue anyway
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-nd-bg px-4">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-nd-surface ring-1 ring-nd-divider">
            <svg viewBox="0 0 32 32" className="h-5 w-5 text-nd-accent">
              <path d="M9 23V9l14 14V9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </span>
          <span className="text-xl font-semibold">NodeDesk</span>
        </div>

        <h1 className="mt-8 text-2xl font-bold tracking-tight">How do you want to use this computer?</h1>
        <p className="mt-2 text-sm text-nd-dim">
          You can change this later. NodeDesk configures everything needed for your choice automatically.
        </p>

        <div className="mt-6 space-y-3">
          {options.map((o) => (
            <button
              key={o.mode}
              onClick={() => setMode(o.mode)}
              className={`flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition-colors ${
                mode === o.mode
                  ? 'border-nd-accent bg-nd-accent/10'
                  : 'border-nd-divider bg-nd-surface hover:border-nd-text'
              }`}
            >
              <o.icon className={`mt-0.5 h-5 w-5 ${mode === o.mode ? 'text-nd-ok' : 'text-nd-dim'}`} />
              <span className="flex-1">
                <span className="flex items-center gap-2 font-medium">
                  {o.title}
                  {o.recommended && (
                    <span className="rounded-full bg-nd-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-nd-accent-strong">
                      Recommended
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-sm text-nd-dim">{o.text}</span>
              </span>
              <span
                className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border ${
                  mode === o.mode ? 'border-nd-accent bg-nd-accent text-nd-on-accent' : 'border-nd-divider'
                }`}
              >
                {mode === o.mode && <Check className="h-3 w-3" />}
              </span>
            </button>
          ))}
        </div>

        <button
          onClick={() => void start()}
          className="mt-6 w-full rounded-xl bg-nd-accent py-3 text-sm font-semibold text-nd-on-accent transition-colors hover:brightness-110"
        >
          Continue
        </button>
        <p className="mt-4 text-center text-xs text-nd-dim">
          NodeDesk never exposes this computer to the public internet.
        </p>
      </div>
    </div>
  )
}
