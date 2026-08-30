import { useState } from 'react'
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpToLine,
  BrainCircuit,
  FolderSync,
  Lock,
  MonitorPlay,
  Moon,
  Power,
  RefreshCcw,
  TerminalSquare,
} from 'lucide-react'
import { api, type Computer } from '../lib/api'

const tabs = ['Desktop', 'Files', 'Terminal', 'System'] as const
type Tab = (typeof tabs)[number]

export default function DeviceDetail({ computer, onBack }: { computer: Computer; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('Desktop')

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-5 py-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100">
        <ArrowLeft className="h-4 w-4" /> My Computers
      </button>

      <div className="mt-4 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold">
            <span className={`h-2.5 w-2.5 rounded-full ${computer.online ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            {computer.name}
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            {computer.specs} · {computer.os}
          </p>
        </div>
        <div className="flex gap-1.5">
          {(
            [
              { icon: Moon, action: 'sleep', label: 'Sleep' },
              { icon: RefreshCcw, action: 'restart', label: 'Restart' },
              { icon: Power, action: 'shutdown', label: 'Shut down' },
              { icon: Lock, action: 'lock', label: 'Lock' },
            ] as const
          ).map((b) => (
            <button
              key={b.action}
              title={b.label}
              onClick={() => void api.power(computer.id, b.action)}
              className="rounded-lg border border-zinc-800 p-2.5 text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100"
            >
              <b.icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      <nav className="mt-5 flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900/50 p-1">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
              tab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      <div className="mt-5">
        {tab === 'Desktop' && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-center">
            <MonitorPlay className="mx-auto h-10 w-10 text-emerald-400" />
            <h2 className="mt-4 font-semibold">Remote desktop</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-400">
              Opens a hardware-accelerated desktop session. Quality is automatic — AV1 / HEVC / H.264, 4K, HDR and
              high refresh are chosen for you.
            </p>
            <button
              onClick={() => void api.connect(computer.id)}
              className="mt-6 rounded-xl bg-emerald-500 px-8 py-3 text-sm font-bold tracking-widest text-zinc-950 hover:bg-emerald-400"
            >
              CONNECT
            </button>
            <p className="mt-3 text-[11px] text-zinc-600">Video quality: Automatic · Clipboard sync: On</p>
          </div>
        )}

        {tab === 'Files' && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8">
            <FolderSync className="h-8 w-8 text-emerald-400" />
            <h2 className="mt-3 font-semibold">File transfer</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Move files between your computers over the same encrypted connection — no extra app.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button className="flex items-center justify-center gap-2 rounded-xl border border-zinc-700 py-3 text-sm hover:bg-zinc-800">
                <ArrowUpToLine className="h-4 w-4" /> Send files
              </button>
              <button className="flex items-center justify-center gap-2 rounded-xl border border-zinc-700 py-3 text-sm hover:bg-zinc-800">
                <ArrowDownToLine className="h-4 w-4" /> Receive files
              </button>
            </div>
            <p className="mt-4 text-[11px] text-zinc-600">
              Drag & drop and resume of interrupted transfers arrive in NodeDesk 0.2.
            </p>
          </div>
        )}

        {tab === 'Terminal' && (
          <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-xs text-zinc-500">
              <TerminalSquare className="h-3.5 w-3.5" /> Secure remote shell — {computer.name}
            </div>
            <div className="p-4 font-mono text-sm leading-7 text-zinc-300">
              <p>
                <span className="text-emerald-400">user@{computer.name.toLowerCase().replace(/\s+/g, '-')}</span>
                <span className="text-zinc-500">:~$</span> nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader
              </p>
              <p className="text-zinc-400">72 %</p>
              <p>
                <span className="text-emerald-400">user@{computer.name.toLowerCase().replace(/\s+/g, '-')}</span>
                <span className="text-zinc-500">:~$</span> <span className="animate-pulse">▌</span>
              </p>
            </div>
          </div>
        )}

        {tab === 'System' && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
              <h2 className="flex items-center gap-2 font-semibold">
                <BrainCircuit className="h-4 w-4 text-emerald-400" /> AI services
              </h2>
              <div className="mt-4 space-y-2">
                {(computer.services ?? []).map((s) => (
                  <div key={s.name} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                    <span className="flex items-center gap-2.5 text-sm">
                      <span className={`h-2 w-2 rounded-full ${s.running ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                      {s.name}
                    </span>
                    {s.running && s.url && (
                      <a href={s.url} target="_blank" rel="noreferrer" className="text-xs font-semibold tracking-wide text-emerald-400 hover:text-emerald-300">
                        OPEN
                      </a>
                    )}
                  </div>
                ))}
                {!computer.services?.length && <p className="text-sm text-zinc-500">No known services detected.</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Network', computer.network ?? '—'],
                ['Uptime', computer.uptime ?? '—'],
                ['RAM', computer.ramTotalGb ? `${computer.ramUsedGb} / ${computer.ramTotalGb} GB` : '—'],
                ['VRAM', computer.vramTotalGb ? `${computer.vramUsedGb} / ${computer.vramTotalGb} GB` : '—'],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-widest text-zinc-500">{k}</p>
                  <p className="mt-1 font-mono text-zinc-200">{v}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
