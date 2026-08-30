import { Cpu, MonitorCog } from 'lucide-react'
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
}: {
  computer: Computer
  onOpen: (c: Computer) => void
}) {
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
          <span className="text-xs text-zinc-500">{computer.os}</span>
        </button>
        <MonitorCog className="h-4 w-4 text-zinc-600" />
      </div>

      <p className="mt-1.5 text-xs text-zinc-500">{computer.specs}</p>

      {computer.online && (
        <div className="mt-3.5 space-y-1.5">
          {computer.cpuPct !== undefined && <Meter label="CPU" pct={computer.cpuPct} />}
          {computer.gpuPct !== undefined && <Meter label="GPU" pct={computer.gpuPct} />}
          {computer.network && (
            <p className="flex items-center gap-1.5 pt-1 text-[11px] text-zinc-500">
              <Cpu className="h-3 w-3" /> {computer.network} · up {computer.uptime}
            </p>
          )}
        </div>
      )}

      {computer.online ? (
        <button
          onClick={() => {
            void api.connect(computer.id)
            onOpen(computer)
          }}
          className="mt-4 w-full rounded-lg bg-emerald-500 py-2.5 text-xs font-bold tracking-widest text-zinc-950 transition-colors hover:bg-emerald-400"
        >
          CONNECT
        </button>
      ) : (
        <button
          onClick={() => void api.wake(computer.id)}
          className="mt-4 w-full rounded-lg border border-zinc-700 py-2.5 text-xs font-bold tracking-widest text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          WAKE
        </button>
      )}
    </div>
  )
}
