import { useState } from 'react'
import { Link2 } from 'lucide-react'
import type { Computer } from '../lib/api'
import { api } from '../lib/api'

function Meter({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-nd-dim">
      <span className="w-8 font-mono">{label}</span>
      <div className="h-1 flex-1 rounded-full bg-nd-surface">
        <div className={`h-1 rounded-full ${pct > 75 ? 'bg-nd-danger' : 'bg-nd-ok'}`} style={{ width: `${pct}%` }} />
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
    <div className="rounded-2xl border border-nd-divider bg-nd-surface p-5 transition-colors hover:border-nd-text">
      <div className="flex items-center justify-between">
        <button onClick={() => onOpen(computer)} className="flex items-center gap-2.5 text-left">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              computer.online ? 'bg-nd-ok' : 'bg-nd-dim'
            }`}
          />
          <span className="font-semibold">{computer.name}</span>
          <span className="rounded bg-nd-surface px-1.5 py-0.5 text-[10px] uppercase text-nd-dim">{computer.via}</span>
        </button>
        <span className="font-mono text-[11px] text-nd-dim">{computer.address}</span>
      </div>

      <p className="mt-1.5 text-xs text-nd-dim">{computer.specs}</p>

      {computer.online && computer.cpuPct !== undefined && (
        <div className="mt-3.5 space-y-1.5">
          <Meter label="CPU" pct={computer.cpuPct} />
          {computer.gpuPct !== undefined && <Meter label="GPU" pct={computer.gpuPct} />}
          {computer.uptime && <p className="pt-1 text-[11px] text-nd-dim">up {computer.uptime}</p>}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        {computer.online ? (
          <>
            <button
              onClick={() => onOpen(computer)}
              className="flex-1 rounded-lg bg-nd-accent py-2.5 text-xs font-bold tracking-widest text-nd-on-accent transition-colors hover:brightness-110"
            >
              CONNECT
            </button>
            {!computer.hasAccessCode && (
              <button
                onClick={() => onPair(computer)}
                className="flex items-center gap-1.5 rounded-lg border border-nd-divider px-4 py-2.5 text-xs font-bold tracking-widest text-nd-text transition-colors hover:bg-nd-surface"
              >
                <Link2 className="h-3.5 w-3.5" /> PAIR
              </button>
            )}
          </>
        ) : (
          <button
            onClick={() => void wake()}
            disabled={busy}
            className="flex-1 rounded-lg border border-nd-divider py-2.5 text-xs font-bold tracking-widest text-nd-text transition-colors hover:bg-nd-surface disabled:opacity-50"
          >
            {busy ? 'SENDING…' : 'WAKE'}
          </button>
        )}
      </div>
    </div>
  )
}
