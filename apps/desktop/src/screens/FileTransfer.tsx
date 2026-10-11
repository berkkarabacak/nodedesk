import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, FolderOpen } from 'lucide-react'
import { api, isNativeShell, type Computer, type ConflictPolicy, type FileEntry } from '../lib/api'
import { useTransfers } from '../lib/useTransfers'
import { Button, Notice, Segmented } from '../components/ui'

function fmt(bytes: number) {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** Progress is acknowledged bytes / total; 0–100 only; zero-byte files show
 * Done without dividing (FILE-03/04). Speed/ETA are omitted when unknown. */
function pctOf(done: number, total: number, state: string) {
  if (state === 'completed') return 100
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

const STATE_LABEL: Record<string, string> = {
  queued: 'Queued',
  transferring: 'Sending',
  verifying: 'Verifying',
  interrupted: 'Interrupted',
  completed: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
}

/**
 * Screen 07 — File Transfer. Real native queue with per-transfer IDs,
 * independent cancel, and identity-checked retry (M7). The target is bound
 * when an item is queued; changing the picker never retargets it (FILE-10).
 */
export default function FileTransfer({
  preferredTargetId,
  signedIn,
}: {
  preferredTargetId?: string
  signedIn?: boolean
}) {
  const [computers, setComputers] = useState<Computer[]>([])
  const [target, setTarget] = useState<Computer | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [conflict, setConflict] = useState<ConflictPolicy>('keep-both')
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const { items, enqueueSend, enqueueReceive, cancel, retry, clearFinished } = useTransfers()

  const notify = (text: string, isError = false) => {
    setMessage({ text, isError })
    setTimeout(() => setMessage(null), 6000)
  }

  useEffect(() => {
    const load = signedIn
      ? api.listDirectoryComputers().then((saved) =>
          saved.map((s) => ({
            id: s.deviceId,
            name: s.name,
            os: '',
            address: s.endpoints?.[0] ?? s.publicId,
            via: 'manual' as const,
            online: s.online === true,
            specs: 'Saved computer',
            hasAccessCode: false,
          })),
        )
      : api.listComputers()
    load
      .then((cs) => {
        setComputers(cs)
        setTarget((prev) => prev ?? cs.find((c) => c.id === preferredTargetId) ?? cs.find((c) => c.online) ?? cs[0] ?? null)
      })
      .catch(() => notify("We couldn't load your computers.", true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])

  const load = useCallback(
    (p: string) => {
      if (!target) return
      setLoading(true)
      api
        .listFiles(target.address, p)
        .then((e) => {
          setEntries(e)
          setPath(p)
        })
        .catch((e) => notify(String(e), true))
        .finally(() => setLoading(false))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target],
  )

  useEffect(() => {
    setPath('')
    setEntries([])
    if (target?.online) load('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // Native drag & drop supplies real filesystem paths (Tauri only). The
  // browser preview cannot provide native paths, so Send is disabled there
  // with an explanation rather than pretending to transfer (FILE-01).
  useEffect(() => {
    if (!isNativeShell || !target) return
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
              enqueueSend(target.address, paths, conflict).catch((e) => notify(String(e), true))
            }
          }
        })
        .then((fn) => (unlisten = fn)),
    )
    return () => unlisten?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, conflict])

  const download = (name: string) => {
    if (!target) return
    const remote = path ? `${path}/${name}` : name
    enqueueReceive(target.address, remote, conflict).catch((e) => notify(String(e), true))
  }

  const enter = (name: string) => load(path ? `${path}/${name}`.replace(/\/{2,}/g, '/') : name)
  const up = () => {
    const parts = path.split(/[\\/]/).filter(Boolean)
    parts.pop()
    load(parts.join('/'))
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-extrabold">File Transfer</h1>
      <p className="mt-1 text-sm text-nd-dim">Send files to a computer, or download files from it.</p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <label htmlFor="ft-target" className="text-sm font-semibold">
          Computer
        </label>
        <select
          id="ft-target"
          value={target?.id ?? ''}
          onChange={(e) => setTarget(computers.find((c) => c.id === e.target.value) ?? null)}
          className="border-2 border-nd-divider bg-nd-surface px-3 py-2 text-sm outline-none"
        >
          {computers.length === 0 && <option value="">No computers found</option>}
          {computers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} {c.online ? '' : '(offline)'}
            </option>
          ))}
        </select>
        <span className="flex items-center gap-2 text-xs text-nd-dim">
          If a file exists:
          <Segmented<ConflictPolicy>
            ariaLabel="When the destination file exists"
            value={conflict}
            onChange={setConflict}
            options={[
              { value: 'keep-both', label: 'Keep both' },
              { value: 'overwrite', label: 'Overwrite' },
            ]}
          />
        </span>
      </div>

      {message && (
        <div className="mt-4">
          <Notice tone={message.isError ? 'error' : 'ok'}>{message.text}</Notice>
        </div>
      )}

      {target && !target.online && (
        <div className="mt-4">
          <Notice tone="info">This computer is offline. Connect it to the network to transfer files.</Notice>
        </div>
      )}

      {target?.online && (
        <>
          <div
            className={`mt-6 border-2 border-dashed p-8 text-center transition-colors ${
              dragOver ? 'border-nd-accent bg-nd-surface' : 'border-nd-divider bg-nd-surface'
            }`}
          >
            <ArrowUp className="mx-auto h-5 w-5 text-nd-dim" aria-hidden />
            <p className="mt-2 text-sm font-semibold">Send to {target.name}</p>
            <p className="mt-1 text-xs text-nd-dim">
              {isNativeShell
                ? 'Drop files here to send them. Folders are not supported yet — compress them first.'
                : 'Sending needs the desktop app — a browser cannot provide real file paths.'}
            </p>
          </div>

          <div className="mt-6 border-2 border-nd-divider bg-nd-surface">
            <div className="flex items-center justify-between border-b-2 border-nd-divider px-4 py-2.5">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <ArrowDown className="h-4 w-4" aria-hidden /> Receive from {target.name}
              </p>
              <div className="flex items-center gap-2">
                {path && (
                  <Button variant="secondary" onClick={up}>
                    Up
                  </Button>
                )}
                <Button variant="secondary" onClick={() => load(path)} ariaLabel="Refresh folder">
                  ↻
                </Button>
              </div>
            </div>
            <p className="border-b border-nd-rule px-4 py-1.5 font-mono text-xs text-nd-dim">/{path}</p>
            {loading ? (
              <p className="px-4 py-6 text-sm text-nd-dim">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="px-4 py-6 text-sm text-nd-dim">This folder is empty.</p>
            ) : (
              <ul>
                {entries.map((e) => (
                  <li key={e.name} className="flex items-center justify-between border-b border-nd-rule px-4 py-2.5 last:border-b-0">
                    {e.isDir ? (
                      <button onClick={() => enter(e.name)} className="flex items-center gap-2 text-sm font-semibold hover:underline">
                        <FolderOpen className="h-4 w-4 text-nd-dim" aria-hidden /> {e.name}
                      </button>
                    ) : (
                      <>
                        <span className="truncate text-sm">{e.name}</span>
                        <span className="flex items-center gap-3">
                          <span className="text-xs text-nd-dim">{fmt(e.size)}</span>
                          <Button variant="secondary" onClick={() => download(e.name)}>
                            Download
                          </Button>
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {items.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-nd-dim">Transfers</h2>
            <button onClick={clearFinished} className="text-xs font-semibold text-nd-accent-strong hover:underline">
              Clear finished
            </button>
          </div>
          <ul className="mt-2 divide-y divide-nd-rule border-2 border-nd-divider bg-nd-surface" aria-live="polite">
            {items.map((t) => {
              const pct = pctOf(t.doneBytes, t.totalBytes, t.state)
              const active = t.state === 'queued' || t.state === 'transferring' || t.state === 'verifying'
              const retryable = t.state === 'interrupted' || t.state === 'failed' || t.state === 'cancelled'
              const targetName = computers.find((c) => c.address === t.address || c.id === t.address)?.name ?? t.address
              return (
                <li key={t.transferId} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-semibold">
                      {t.direction === 'up' ? '↑' : '↓'} {t.file}
                      <span className="ml-2 text-xs font-normal text-nd-dim">{targetName}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className={`text-xs font-semibold ${t.state === 'failed' || t.state === 'interrupted' ? 'text-nd-danger' : t.state === 'completed' ? 'text-nd-ok' : 'text-nd-dim'}`}>
                        {t.state === 'transferring' ? `${STATE_LABEL[t.state]} ${pct}%` : STATE_LABEL[t.state] ?? t.state}
                      </span>
                      {active && (
                        <button onClick={() => void cancel(t.transferId)} className="text-xs font-semibold text-nd-danger underline">
                          Cancel
                        </button>
                      )}
                      {retryable && (
                        <button onClick={() => void retry(t.transferId).catch((e) => notify(String(e), true))} className="text-xs font-semibold text-nd-accent-strong underline">
                          Retry
                        </button>
                      )}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${t.file} progress`}
                    className="mt-2 h-2 w-full bg-nd-rule"
                  >
                    <div className="h-2 bg-nd-accent transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-nd-dim">
                    {t.totalBytes > 0 ? `${fmt(t.doneBytes)} of ${fmt(t.totalBytes)}` : t.state === 'completed' ? 'Empty file' : 'Preparing…'}
                  </p>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
