import { useState } from 'react'
import { Link2 } from 'lucide-react'
import type { Computer } from '../lib/api'
import { api } from '../lib/api'

function Meter({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-zinc-400">
      <span className="w-8 font-mono">{label}</span>
      <div className="h-1 flex-1 rounded-full bg-zinc-800">
        <div className={`h-1 rounded-full ${pct > 75 ? 'bg-amber-400/80' : 'bg-emerald-500/70'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-9 text-right font-mono">{pct}%</span>
    </div>
  )
}

export default function ComputerCard({
  computer,
  onOpen,
  onPair,
  onMessage,
}: {
  computer: Computer
  onOpen: (c: Computer) => void
  onPair: (c: Computer) => void
  onMessage: (msg: string, isError?: boolean) => void
}) {
  const [busy, setBusy] = useState(false)

  const wake = async () => {
    setBusy(true)
    try {
      await api.wake(computer.address)
      onMessage(`Wake signal sent to ${computer.name} — give it a minute`)
    } catch (e) {
      onMessage(String(e), true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 transition-colors hover:border-zinc-700">
      <div className="flex items-center justify-between">
        <button onClick={() => onOpen(computer)} className="flex items-center gap-2.5 text-left">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              computer.online ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]' : 'bg-zinc-600'
            }`}
          />
          <span className="font-semibold">{computer.name}</span>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500">{computer.via}</span>
        </button>
        <span className="font-mono text-[11px] text-zinc-600">{computer.address}</span>
      </div>

      <p className="mt-1.5 text-xs text-zinc-500">{computer.specs}</p>

      {computer.online && computer.cpuPct !== undefined && (
        <div className="mt-3.5 space-y-1.5">
          <Meter label="CPU" pct={computer.cpuPct} />
          {computer.gpuPct !== undefined && <Meter label="GPU" pct={computer.gpuPct} />}
          {computer.uptime && <p className="pt-1 text-[11px] text-zinc-500">up {computer.uptime}</p>}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        {computer.online ? (
          <>
            <button
              onClick={() => onOpen(computer)}
              className="flex-1 rounded-lg bg-emerald-500 py-2.5 text-xs font-bold tracking-widest text-zinc-950 transition-colors hover:bg-emerald-400"
            >
              CONNECT
            </button>
            {!computer.hasAccessCode && (
              <button
                onClick={() => onPair(computer)}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2.5 text-xs font-bold tracking-widest text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                <Link2 className="h-3.5 w-3.5" /> PAIR
              </button>
            )}
          </>
        ) : (
          <button
            onClick={() => void wake()}
            disabled={busy}
            className="flex-1 rounded-lg border border-zinc-700 py-2.5 text-xs font-bold tracking-widest text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
          >
            {busy ? 'SENDING…' : 'WAKE'}
          </button>
        )}
      </div>
    </div>
  )
}
