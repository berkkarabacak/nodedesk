import { useState } from 'react'
import {
  ArrowLeft,
  BrainCircuit,
  FolderSync,
  Lock,
  MonitorPlay,
  Moon,
  Power,
  RefreshCcw,
  Square,
  TerminalSquare,
} from 'lucide-react'
import { api, type Computer } from '../lib/api'

const tabs = ['Desktop', 'Files', 'Terminal', 'System'] as const
type Tab = (typeof tabs)[number]

export default function DeviceDetail({ computer, onBack }: { computer: Computer; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('Desktop')
  const [streaming, setStreaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null)

  const notify = (text: string, isError = false) => {
    setMessage({ text, isError })
    setTimeout(() => setMessage(null), 7000)
  }

  const connect = async () => {
    setBusy(true)
    try {
      await api.connect(computer.address)
      setStreaming(true)
      notify(`Remote desktop opened — ${computer.name}`)
    } catch (e) {
      notify(String(e), true)
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    try {
      await api.disconnect()
      setStreaming(false)
    } catch (e) {
      notify(String(e), true)
    }
  }

  const power = async (action: 'sleep' | 'restart' | 'shutdown' | 'lock') => {
    try {
      await api.power(computer.address, action)
      notify(`${action} sent to ${computer.name}`)
    } catch (e) {
      notify(String(e), true)
    }
  }

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
            {computer.specs} · {computer.address}
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
              onClick={() => void power(b.action)}
              className="rounded-lg border border-zinc-800 p-2.5 text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100"
            >
              <b.icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      {message && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            message.isError
              ? 'border-red-500/30 bg-red-500/10 text-red-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {message.text}
        </div>
      )}

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
              Hardware-accelerated session with synced clipboard. Quality is automatic; tune it in Settings →
              Advanced.
            </p>
            {streaming ? (
              <button
                onClick={() => void disconnect()}
                className="mt-6 inline-flex items-center gap-2 rounded-xl border border-red-500/40 px-8 py-3 text-sm font-bold tracking-widest text-red-300 hover:bg-red-500/10"
              >
                <Square className="h-3.5 w-3.5" /> DISCONNECT
              </button>
            ) : (
              <button
                onClick={() => void connect()}
                disabled={busy || !computer.online}
                className="mt-6 rounded-xl bg-emerald-500 px-8 py-3 text-sm font-bold tracking-widest text-zinc-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                {busy ? 'STARTING…' : 'CONNECT'}
              </button>
            )}
            {!computer.hasAccessCode && (
              <p className="mt-3 text-[11px] text-zinc-600">
                Tip: pair first and save this computer's access code for stats and power controls.
              </p>
            )}
          </div>
        )}

        {tab === 'Files' && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8">
            <FolderSync className="h-8 w-8 text-emerald-400" />
            <h2 className="mt-3 font-semibold">File transfer</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Copy and paste files directly inside the remote desktop session — clipboard sync carries them across.
            </p>
            <p className="mt-4 text-[11px] text-zinc-600">
              Drag & drop transfers with resume arrive in the next release.
            </p>
          </div>
        )}

        {tab === 'Terminal' && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8">
            <TerminalSquare className="h-8 w-8 text-emerald-400" />
            <h2 className="mt-3 font-semibold">Remote terminal</h2>
            <p className="mt-1 text-sm text-zinc-400">
              The integrated secure shell arrives in the next release. Until then, run terminals inside the remote
              desktop session.
            </p>
          </div>
        )}

        {tab === 'System' && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
              <h2 className="flex items-center gap-2 font-semibold">
                <BrainCircuit className="h-4 w-4 text-emerald-400" /> AI services
              </h2>
              <p className="mt-2 text-sm text-zinc-500">
                Automatic detection of Ollama, Open WebUI, ComfyUI and friends arrives in the next release.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Network', computer.address],
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
