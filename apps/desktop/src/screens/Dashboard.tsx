import { useEffect, useState } from 'react'
import { Activity, Radar, Settings, ShieldCheck } from 'lucide-react'
import { api, type Computer } from '../lib/api'
import ComputerCard from '../components/ComputerCard'

export default function Dashboard({
  onOpenDevice,
  onOpenSettings,
  onOpenDiagnostics,
}: {
  onOpenDevice: (c: Computer) => void
  onOpenSettings: () => void
  onOpenDiagnostics: () => void
}) {
  const [computers, setComputers] = useState<Computer[]>([])
  const [scanning, setScanning] = useState(false)

  const refresh = () => api.listComputers().then(setComputers)

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [])

  const rescan = () => {
    setScanning(true)
    setTimeout(() => {
      void refresh()
      setScanning(false)
    }, 1200)
  }

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-5 py-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 ring-1 ring-zinc-800">
            <svg viewBox="0 0 32 32" className="h-5 w-5">
              <path d="M9 23V9l14 14V9" stroke="#34d399" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </span>
          <div>
            <h1 className="text-sm font-semibold tracking-widest text-zinc-300">MY COMPUTERS</h1>
            <p className="flex items-center gap-1 text-[11px] text-zinc-500">
              <ShieldCheck className="h-3 w-3 text-emerald-500" /> 3 trusted devices · Tailscale connected
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onOpenDiagnostics} title="Diagnostics" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
            <Activity className="h-4.5 w-4.5" />
          </button>
          <button onClick={onOpenSettings} title="Settings" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
            <Settings className="h-4.5 w-4.5" />
          </button>
        </div>
      </header>

      <div className="mt-6 space-y-4">
        {computers.map((c) => (
          <ComputerCard key={c.id} computer={c} onOpen={onOpenDevice} />
        ))}
      </div>

      <button
        onClick={rescan}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-800 py-4 text-sm text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-300"
      >
        <Radar className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
        {scanning ? 'Scanning your network…' : 'Scan network for computers'}
      </button>
    </div>
  )
}
