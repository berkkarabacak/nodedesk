import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  BrainCircuit,
  Download,
  File,
  Folder,
  FolderSync,
  Loader2,
  Lock,
  MonitorPlay,
  Moon,
  Power,
  RefreshCcw,
  Square,
  UploadCloud,
  X,
} from 'lucide-react'
import { api, onEvent, type Computer, type FileEntry, type TransferProgress } from '../lib/api'

const isTauri = '__TAURI_INTERNALS__' in window

const tabs = ['Desktop', 'Files', 'Terminal', 'System'] as const
type Tab = (typeof tabs)[number]

function fmtSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

// ---------------------------------------------------------------------------

function FilesTab({ computer, notify }: { computer: Computer; notify: (m: string, e?: boolean) => void }) {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [transfer, setTransfer] = useState<TransferProgress | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const load = useCallback(
    (p: string) => {
      setLoading(true)
      api
        .listFiles(computer.address, p)
        .then((e) => {
          setEntries(e)
          setPath(p)
        })
        .catch((e) => notify(String(e), true))
        .finally(() => setLoading(false))
    },
    [computer.address, notify],
  )

  useEffect(() => load(''), [load])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onEvent('transfer-progress', (p: TransferProgress) => {
      setTransfer(p)
      if (p.finished) setTimeout(() => setTransfer(null), 3000)
    }).then((fn) => (unlisten = fn))
    return () => unlisten?.()
  }, [])

  // Tauri native drag & drop provides real file system paths.
  useEffect(() => {
    if (!isTauri) return
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .onDragDropEvent((event) => {
          if (event.payload.type === 'over') setDragOver(true)
          if (event.payload.type === 'leave') setDragOver(false)
          if (event.payload.type === 'drop') {
            setDragOver(false)
            const paths = event.payload.paths
            if (paths.length) {
              notify(`Sending ${paths.length} file(s) to ${computer.name}…`)
              api.sendFiles(computer.address, paths).catch((e) => notify(String(e), true))
            }
          }
        })
        .then((fn) => (unlisten = fn)),
    )
    return () => unlisten?.()
  }, [computer.address, computer.name, notify])

  const enter = (name: string) => load(path ? `${path}/${name}`.replace(/\/{2,}/g, '/') : name)
  const up = () => {
    const parts = path.split(/[\\/]/).filter(Boolean)
    parts.pop()
    load(parts.join('/'))
  }

  const download = (name: string) => {
    const remote = path ? `${path}/${name}` : name
    notify(`Downloading ${name}…`)
    api
      .downloadFile(computer.address, remote)
      .then((saved) => notify(`Saved to ${saved}`))
      .catch((e) => notify(String(e), true))
  }

  return (
    <div
      className={`rounded-2xl border p-5 transition-colors ${
        dragOver ? 'border-emerald-400 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-900/40'
      }`}
    >
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold">
          <FolderSync className="h-4 w-4 text-emerald-400" /> Files on {computer.name}
        </h2>
        <button onClick={() => load(path)} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
          <RefreshCcw className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-400">
        {path && (
          <button onClick={up} className="text-emerald-400 hover:text-emerald-300">
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="truncate">/{path}</span>
      </div>

      <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
        {loading && (
          <p className="flex items-center gap-2 py-3 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {!loading &&
          entries.map((e) => (
            <div key={e.name} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-zinc-800/60">
              <button
                onClick={() => e.isDir && enter(e.name)}
                className={`flex items-center gap-2.5 text-sm ${e.isDir ? 'text-zinc-100' : 'text-zinc-400'}`}
              >
                {e.isDir ? <Folder className="h-4 w-4 text-emerald-400" /> : <File className="h-4 w-4" />}
                {e.name}
              </button>
              <span className="flex items-center gap-3">
                {!e.isDir && <span className="text-xs text-zinc-600">{fmtSize(e.size)}</span>}
                {!e.isDir && (
                  <button onClick={() => download(e.name)} title="Download" className="text-zinc-500 hover:text-emerald-400">
                    <Download className="h-4 w-4" />
                  </button>
                )}
              </span>
            </div>
          ))}
      </div>

      {transfer && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-300">
              {transfer.direction === 'up' ? 'Sending' : 'Receiving'} {transfer.file}
            </span>
            <button onClick={() => void api.cancelTransfer()} className="text-zinc-500 hover:text-red-400">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-zinc-800">
            <div
              className="h-1.5 rounded-full bg-emerald-500 transition-all"
              style={{ width: `${transfer.totalBytes ? Math.min(100, (transfer.doneBytes / transfer.totalBytes) * 100) : 0}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            {fmtSize(transfer.doneBytes)} / {fmtSize(transfer.totalBytes)}
            {transfer.finished && ' — done'}
          </p>
        </div>
      )}

      <p className="mt-4 flex items-center gap-2 border-t border-zinc-800 pt-4 text-[11px] text-zinc-600">
        <UploadCloud className="h-3.5 w-3.5" />
        Drop files anywhere on this panel to send them. Interrupted transfers resume automatically.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

function TerminalTab({ computer, notify }: { computer: Computer; notify: (m: string, e?: boolean) => void }) {
  const [cwd, setCwd] = useState('')
  const [lines, setLines] = useState<{ prompt: string; cmd: string; out: string }[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const run = async () => {
    const cmd = input.trim()
    if (!cmd) return
    setInput('')
    setBusy(true)
    try {
      const r = await api.terminalExec(computer.address, cmd, cwd)
      setLines((l) => [...l, { prompt: cwd || computer.name, cmd, out: r.output }])
      setCwd(r.cwd)
    } catch (e) {
      notify(String(e), true)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
      <div className="border-b border-zinc-800 px-4 py-2.5 text-xs text-zinc-500">
        Secure shell — {computer.name} (requires its access code)
      </div>
      <div className="h-72 overflow-y-auto p-4 font-mono text-sm leading-6">
        {lines.map((l, i) => (
          <div key={i}>
            <p>
              <span className="text-emerald-400">{l.prompt}&gt;</span> {l.cmd}
            </p>
            {l.out && <pre className="whitespace-pre-wrap text-zinc-400">{l.out}</pre>}
          </div>
        ))}
        <div className="flex items-center gap-2">
          <span className="text-emerald-400">{cwd || computer.name}&gt;</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && void run()}
            disabled={busy}
            className="flex-1 bg-transparent text-zinc-100 outline-none"
            placeholder={busy ? 'running…' : 'type a command, Enter to run'}
            autoFocus
          />
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function DeviceDetail({ computer, onBack }: { computer: Computer; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('Desktop')
  const [streaming, setStreaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null)

  const notify = useCallback((text: string, isError = false) => {
    setMessage({ text, isError })
    setTimeout(() => setMessage(null), 7000)
  }, [])

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

  const runningServices = (computer.services ?? []).filter((s) => s.running)

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
          </div>
        )}

        {tab === 'Files' && <FilesTab computer={computer} notify={notify} />}

        {tab === 'Terminal' && <TerminalTab computer={computer} notify={notify} />}

        {tab === 'System' && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
              <h2 className="flex items-center gap-2 font-semibold">
                <BrainCircuit className="h-4 w-4 text-emerald-400" /> AI services
              </h2>
              <div className="mt-4 space-y-2">
                {runningServices.length === 0 && (
                  <p className="text-sm text-zinc-500">No known services running on this computer right now.</p>
                )}
                {runningServices.map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3"
                  >
                    <span className="flex items-center gap-2.5 text-sm">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                      {s.name}
                    </span>
                    <a
                      href={`http://${computer.address}:${s.port}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-semibold tracking-wide text-emerald-400 hover:text-emerald-300"
                    >
                      OPEN
                    </a>
                  </div>
                ))}
              </div>
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
