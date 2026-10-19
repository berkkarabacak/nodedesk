import { useEffect, useRef, useState } from 'react'
import { Activity, Plus, Radar, Settings as SettingsIcon, ShieldCheck, X } from 'lucide-react'
import { api, onEvent, type Computer, type Settings } from '../lib/api'
import ComputerCard from '../components/ComputerCard'

function PairModal({
  computer,
  onClose,
  onMessage,
}: {
  computer: Computer
  onClose: () => void
  onMessage: (msg: string, isError?: boolean) => void
}) {
  const [pin, setPin] = useState<string | null>(null)
  const [status, setStatus] = useState<'starting' | 'waiting' | 'done' | 'error'>('starting')
  const [code, setCode] = useState('')
  const started = useRef(false)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onEvent('pair-pin', (p) => {
      setPin(p)
      setStatus('waiting')
    }).then((fn) => (unlisten = fn))
    if (!started.current) {
      started.current = true
      api
        .pairComputer(computer.address)
        .then(() => setStatus('done'))
        .catch((e) => {
          setStatus('error')
          onMessage(String(e), true)
        })
    }
    return () => unlisten?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveCode = async () => {
    try {
      await api.addManualHost(computer.address, code.replace(/\s/g, ''))
      onMessage(`Access code saved for ${computer.name} — live stats and power controls enabled`)
      onClose()
    } catch (e) {
      onMessage(String(e), true)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-md rounded-2xl border border-nd-divider bg-nd-bg p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Pair with {computer.name}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-nd-dim hover:bg-nd-surface hover:text-nd-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {status === 'starting' && <p className="mt-4 text-sm text-nd-dim">Starting pairing…</p>}

        {pin && status === 'waiting' && (
          <div className="mt-4 rounded-xl border border-nd-ok bg-nd-accent/10 p-4 text-center">
            <p className="text-sm text-nd-text">On the other computer, open NodeDesk and enter this PIN:</p>
            <p className="mt-3 font-mono text-4xl font-bold tracking-[0.4em] text-nd-ok">{pin}</p>
            <p className="mt-3 text-xs text-nd-dim">Waiting for approval… (2 minutes)</p>
          </div>
        )}

        {status === 'done' && (
          <div className="mt-4">
            <p className="text-sm text-nd-ok">Paired — this computer is now trusted.</p>
            <div className="mt-4 rounded-xl border border-nd-divider p-4">
              <p className="text-xs text-nd-dim">
                Optional: enter the access code shown in {computer.name}'s Settings to enable live stats and power
                controls.
              </p>
              <div className="mt-3 flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="XXXX-XXXX"
                  className="flex-1 rounded-lg border border-nd-divider bg-nd-surface px-3 py-2 font-mono text-sm outline-none focus:border-nd-accent"
                />
                <button onClick={() => void saveCode()} className="rounded-lg bg-nd-surface px-4 text-sm hover:brightness-95">
                  Save
                </button>
              </div>
            </div>
            <button onClick={onClose} className="mt-4 w-full rounded-xl bg-nd-accent py-2.5 text-sm font-semibold text-nd-on-accent hover:brightness-110">
              Done
            </button>
          </div>
        )}

        {status === 'error' && (
          <button onClick={onClose} className="mt-6 w-full rounded-xl border border-nd-divider py-2.5 text-sm text-nd-text hover:bg-nd-surface">
            Close
          </button>
        )}
      </div>
    </div>
  )
}

export default function Dashboard({
  settings,
  onOpenDevice,
  onOpenSettings,
  onOpenDiagnostics,
}: {
  settings: Settings
  onOpenDevice: (c: Computer) => void
  onOpenSettings: () => void
  onOpenDiagnostics: () => void
}) {
  const [computers, setComputers] = useState<Computer[]>([])
  const [scanning, setScanning] = useState(false)
  const [pairing, setPairing] = useState<Computer | null>(null)
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [addAddress, setAddAddress] = useState('')
  const [addCode, setAddCode] = useState('')
  const [pinApprove, setPinApprove] = useState('')
  const [approving, setApproving] = useState(false)

  const notify = (text: string, isError = false) => {
    setMessage({ text, isError })
    setTimeout(() => setMessage(null), 6000)
  }

  const refresh = () =>
    api
      .listComputers()
      .then(setComputers)
      .catch(() => {})

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [])

  const rescan = () => {
    setScanning(true)
    void refresh().finally(() => setTimeout(() => setScanning(false), 900))
  }

  const addHost = async () => {
    try {
      const name = await api.addManualHost(addAddress.trim(), addCode.replace(/\s/g, ''))
      notify(`Added ${name}`)
      setShowAdd(false)
      setAddAddress('')
      setAddCode('')
      void refresh()
    } catch (e) {
      notify(String(e), true)
    }
  }

  const approve = async () => {
    setApproving(true)
    try {
      await api.approvePairing(pinApprove)
      notify('PIN approved — the other computer is now paired')
      setPinApprove('')
    } catch (e) {
      notify(String(e), true)
    } finally {
      setApproving(false)
    }
  }

  const isHost = settings.mode === 'host' || settings.mode === 'both'

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-5 py-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-nd-surface ring-1 ring-nd-divider">
            <svg viewBox="0 0 32 32" className="h-5 w-5 text-nd-accent">
              <path d="M9 23V9l14 14V9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </span>
          <div>
            <h1 className="text-sm font-semibold tracking-widest text-nd-text">MY COMPUTERS</h1>
            <p className="flex items-center gap-1 text-[11px] text-nd-dim">
              <ShieldCheck className="h-3 w-3 text-nd-ok" />
              {isHost ? 'This computer can be controlled' : 'Controller mode'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onOpenDiagnostics} title="Diagnostics" className="rounded-lg p-2 text-nd-dim hover:bg-nd-surface hover:text-nd-text">
            <Activity className="h-4 w-4" />
          </button>
          <button onClick={onOpenSettings} title="Settings" className="rounded-lg p-2 text-nd-dim hover:bg-nd-surface hover:text-nd-text">
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
      </header>

      {message && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            message.isError
              ? 'border-nd-danger bg-nd-danger/10 text-nd-danger'
              : 'border-nd-ok bg-nd-ok/10 text-nd-ok'
          }`}
        >
          {message.text}
        </div>
      )}

      {isHost && (
        <div className="mt-6 rounded-2xl border border-nd-divider bg-nd-surface p-5">
          <p className="text-sm font-medium">Approve a pairing</p>
          <p className="mt-1 text-xs text-nd-dim">
            If another computer is pairing with this one and showing a PIN, enter it here.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={pinApprove}
              onChange={(e) => setPinApprove(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="4-digit PIN"
              inputMode="numeric"
              className="w-36 rounded-lg border border-nd-divider bg-nd-bg px-3 py-2 font-mono text-sm tracking-widest outline-none focus:border-nd-accent"
            />
            <button
              onClick={() => void approve()}
              disabled={pinApprove.length !== 4 || approving}
              className="rounded-lg bg-nd-accent px-5 text-sm font-semibold text-nd-on-accent hover:brightness-110 disabled:opacity-40"
            >
              {approving ? 'Approving…' : 'Approve'}
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 space-y-4">
        {computers.length === 0 && (
          <p className="rounded-2xl border border-dashed border-nd-divider p-6 text-center text-sm text-nd-dim">
            No computers found yet. Make sure NodeDesk runs on your other machines, then scan.
          </p>
        )}
        {computers.map((c) => (
          <ComputerCard key={c.id} computer={c} onOpen={onOpenDevice} onPair={setPairing} onMessage={notify} />
        ))}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <button
          onClick={rescan}
          className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-nd-divider py-4 text-sm text-nd-dim transition-colors hover:border-nd-text hover:text-nd-text"
        >
          <Radar className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
          {scanning ? 'Scanning…' : 'Scan network'}
        </button>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-nd-divider py-4 text-sm text-nd-dim transition-colors hover:border-nd-text hover:text-nd-text"
        >
          <Plus className="h-4 w-4" /> Add by address
        </button>
      </div>

      {showAdd && (
        <div className="mt-3 rounded-2xl border border-nd-divider bg-nd-surface p-5">
          <p className="text-sm font-medium">Add a computer manually</p>
          <p className="mt-1 text-xs text-nd-dim">
            Address (IP or hostname) plus the access code from that computer's NodeDesk Settings.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={addAddress}
              onChange={(e) => setAddAddress(e.target.value)}
              placeholder="192.168.1.50"
              className="flex-1 rounded-lg border border-nd-divider bg-nd-bg px-3 py-2 font-mono text-sm outline-none focus:border-nd-accent"
            />
            <input
              value={addCode}
              onChange={(e) => setAddCode(e.target.value)}
              placeholder="Access code"
              className="w-40 rounded-lg border border-nd-divider bg-nd-bg px-3 py-2 font-mono text-sm outline-none focus:border-nd-accent"
            />
            <button onClick={() => void addHost()} className="rounded-lg bg-nd-accent px-5 py-2 text-sm font-semibold text-nd-on-accent hover:brightness-110">
              Add
            </button>
          </div>
        </div>
      )}

      {pairing && <PairModal computer={pairing} onClose={() => setPairing(null)} onMessage={notify} />}
    </div>
  )
}
