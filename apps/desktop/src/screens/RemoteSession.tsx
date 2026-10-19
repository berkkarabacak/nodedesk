import { useEffect, useState } from 'react'
import { api, isNativeShell, type QualityPreset, type RemoteDisplay, type SessionStats } from '../lib/api'
import { SESSION_CONSTANTS } from '../lib/sessionConstants'
import type { ConnectionState, ConnectionTarget } from '../lib/useConnection'
import { Button, Notice, Segmented, Switch } from '../components/ui'

type Panel = 'monitors' | 'quality' | 'files' | 'clipboard' | 'audio' | null

/** Connection progress overlay: one attempt, honest phases, real Cancel. */
export function ConnectionOverlay({
  state,
  onCancel,
  onRetry,
  onBack,
}: {
  state: ConnectionState
  onCancel: () => void
  onRetry: (target: ConnectionTarget) => void
  onBack: () => void
}) {
  if (state.kind === 'idle' || state.kind === 'cancelled' || state.kind === 'connected' || state.kind === 'disconnecting') {
    return null
  }
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label="Connection progress" className="w-full max-w-sm border-2 border-nd-divider bg-nd-bg p-6 shadow-[var(--nd-shadow)]">
        {state.kind === 'failed' ? (
          <>
            <Notice tone="error">{state.message}</Notice>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={onBack}>
                Back to My Computers
              </Button>
              <Button onClick={() => onRetry(state.target)}>Try again</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-bold">
              {state.kind === 'authorizing' && `Checking access to ${state.target.name}…`}
              {state.kind === 'awaitingApproval' && `Waiting for someone to accept on ${state.target.name}.`}
              {state.kind === 'connecting' && `Connecting to ${state.target.name}…`}
              {state.kind === 'reconnecting' && `Reconnecting to ${state.target.name}…`}
            </p>
            {state.kind === 'awaitingApproval' && (
              <p className="mt-2 text-xs text-nd-dim">
                The request expires {SESSION_CONSTANTS.connectTimeoutMs / 1000} seconds after it was sent.
              </p>
            )}
            {state.kind === 'connecting' && (
              <p className="mt-2 text-xs text-nd-dim">Waiting until the other computer is actually on screen.</p>
            )}
            {state.kind === 'reconnecting' && (
              <p className="mt-2 text-xs text-nd-dim">
                The picture is paused. Trying again (attempt {state.attempt} of {SESSION_CONSTANTS.reconnectDelaysMs.length}
                ).
              </p>
            )}
            <div role="progressbar" aria-label="Connection in progress" className="mt-4 h-1 w-full bg-nd-rule">
              <div className="h-1 w-1/3 animate-pulse bg-nd-accent" />
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Screen 06 (interim) — session surface and toolbar. The desktop stream runs
 * in the external Moonlight viewer; this toolbar controls what is real today
 * and says so for what is not (TOOLBAR-01..08). No fake success: stats show
 * placeholders when unmeasured, a second monitor is never invented, quality
 * changes through a controlled restart, and denied capabilities explain.
 */
export default function RemoteSession({
  state,
  onDisconnect,
  onChangeQuality,
  onOpenFiles,
}: {
  state: Extract<ConnectionState, { kind: 'connected' }>
  onDisconnect: () => void
  onChangeQuality: (q: QualityPreset) => Promise<void>
  onOpenFiles: () => void
}) {
  const [panel, setPanel] = useState<Panel>(null)
  const [displays, setDisplays] = useState<RemoteDisplay[] | null>(null)
  const [stats, setStats] = useState<SessionStats | null>(null)
  const [clipboardOn, setClipboardOn] = useState(false)
  const [clipboardText, setClipboardText] = useState('')
  const [clipboardMsg, setClipboardMsg] = useState<string | null>(null)
  const [restartMsg, setRestartMsg] = useState<string | null>(null)

  useEffect(() => {
    api
      .listRemoteDisplays(state.target.deviceId)
      .then(setDisplays)
      .catch(() => setDisplays([]))
    const poll = () =>
      api
        .getSessionStats()
        .then(setStats)
        .catch(() => setStats(null))
    void poll()
    const t = setInterval(() => void poll(), 5000)
    return () => clearInterval(t)
  }, [state.target.deviceId])

  const perms = state.permissions

  const pickQuality = async (q: QualityPreset) => {
    setRestartMsg(null)
    try {
      await onChangeQuality(q)
      // Indicator changes only now — after the relaunch succeeded.
    } catch {
      setRestartMsg("We couldn't apply that quality. The session kept its previous setting.")
    }
  }

  const toggleClipboard = async (v: boolean) => {
    // TOOLBAR-05: gates NodeDesk's own clipboard channel; re-enabling does
    // not push stale cached content.
    setClipboardMsg(null)
    try {
      await api.setSessionClipboard(v)
      setClipboardOn(v)
      if (v) setClipboardText('')
    } catch (e) {
      setClipboardMsg(e instanceof Error ? e.message : "Couldn't change clipboard sharing.")
    }
  }

  const statText = (v: string | number | undefined, suffix = '') => (v === undefined ? `—${suffix}` : `${v}${suffix}`)

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-extrabold">{state.target.name}</h1>
      <p className="mt-1 text-sm text-nd-dim">
        {perms.control ? 'Remote session' : 'Remote session — view only'}
      </p>

      {/* Toolbar (TOOLBAR-01): always reachable in-app while the interim
          external viewer shows the stream. */}
      <div role="toolbar" aria-label="Session controls" className="mt-4 flex flex-wrap items-center gap-1 border-2 border-nd-divider bg-nd-surface px-2 py-1">
        {(
          [
            ['monitors', 'Monitors'],
            ['quality', 'Quality'],
            ['files', 'Files'],
            ['clipboard', 'Clipboard'],
            ['audio', 'Audio'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPanel(panel === id ? null : id)}
            aria-expanded={panel === id}
            className={`px-3 py-2 text-xs font-bold ${panel === id ? 'bg-nd-text text-nd-bg' : 'text-nd-dim hover:bg-nd-bg'}`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto px-2 font-mono text-xs text-nd-dim" aria-live="polite">
          {statText(stats?.resolution)} · {statText(stats?.fps, ' fps')} · {statText(stats?.latencyMs, ' ms')}
        </span>
      </div>

      {panel === 'monitors' && (
        <div className="border-2 border-t-0 border-nd-divider bg-nd-bg p-4">
          {displays === null ? (
            <p className="text-sm text-nd-dim">Checking displays…</p>
          ) : displays.length === 0 ? (
            <Notice tone="info">We couldn&apos;t read the remote displays.</Notice>
          ) : (
            <ul className="divide-y divide-nd-rule">
              {displays.map((d) => (
                <li key={d.index} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    Monitor {d.index} <span className="text-nd-dim">{d.resolution}</span>
                  </span>
                  {d.primary && <span className="text-xs font-bold text-nd-dim">Primary</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-nd-dim">
            Switching displays needs the integrated viewer (in progress) — the interim viewer shows the primary
            display.
          </p>
        </div>
      )}

      {panel === 'quality' && (
        <div className="border-2 border-t-0 border-nd-divider bg-nd-bg p-4">
          <Segmented<QualityPreset>
            ariaLabel="Session quality"
            value={state.quality}
            onChange={(q) => void pickQuality(q)}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'speed', label: 'Best speed' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'quality', label: 'Best quality' },
            ]}
          />
          <p className="mt-2 text-xs text-nd-dim">
            Changing quality restarts the stream with the new setting — it takes a few seconds.
          </p>
          {restartMsg && (
            <div className="mt-2">
              <Notice tone="error">{restartMsg}</Notice>
            </div>
          )}
        </div>
      )}

      {panel === 'clipboard' && (
        <div className="border-2 border-t-0 border-nd-divider bg-nd-bg p-4">
          {perms.clipboard ? (
            <>
              <label className="flex items-center justify-between text-sm">
                <span>
                  Share clipboard
                  <span className="block text-xs text-nd-dim">Copy and paste between computers</span>
                </span>
                <Switch checked={clipboardOn} onChange={(v) => void toggleClipboard(v)} label="Share clipboard" />
              </label>
              <div className="mt-3 flex gap-2">
                <input
                  value={clipboardText}
                  onChange={(e) => setClipboardText(e.target.value)}
                  placeholder="Text to send"
                  aria-label="Clipboard text"
                  className="flex-1 border-2 border-nd-divider bg-nd-surface px-3 py-2 text-sm outline-none"
                />
                <Button
                  variant="secondary"
                  disabled={!clipboardOn}
                  onClick={() => {
                    // "Sent" only after the native write succeeds.
                    void api
                      .sendClipboard(clipboardText)
                      .then(() => setClipboardMsg('Sent to remote.'))
                      .catch((e) => setClipboardMsg(e instanceof Error ? e.message : 'Send failed.'))
                  }}
                >
                  Send to remote
                </Button>
                <Button
                  variant="secondary"
                  disabled={!clipboardOn}
                  onClick={() => {
                    void api
                      .receiveClipboard()
                      .then((text) => {
                        setClipboardText(text)
                        setClipboardMsg('Got remote clipboard.')
                      })
                      .catch((e) => setClipboardMsg(e instanceof Error ? e.message : 'Receive failed.'))
                  }}
                >
                  Get from remote
                </Button>
              </div>
              <p className="mt-2 text-xs text-nd-dim">
                This controls NodeDesk&apos;s own clipboard channel; the viewer&apos;s built-in clipboard follows
                its own behavior.
              </p>
            </>
          ) : (
            <Notice tone="info">The other computer didn&apos;t allow clipboard sharing for this session.</Notice>
          )}
          {clipboardMsg && (
            <p role="status" className="mt-2 text-xs font-semibold text-nd-ok">
              {clipboardMsg}
            </p>
          )}
        </div>
      )}

      {panel === 'audio' && (
        <div className="border-2 border-t-0 border-nd-divider bg-nd-bg p-4">
          {perms.audio ? (
            <Notice tone="info">
              Audio plays through the viewer window. In-app volume and mute arrive with the integrated viewer.
            </Notice>
          ) : (
            <Notice tone="info">The other computer didn&apos;t allow audio for this session.</Notice>
          )}
        </div>
      )}

      {panel === 'files' && (
        <div className="border-2 border-t-0 border-nd-divider bg-nd-bg p-4">
          {perms.files ? (
            <>
              <p className="text-sm text-nd-dim">Send files to {state.target.name} or download from it.</p>
              <div className="mt-3">
                <Button variant="secondary" onClick={onOpenFiles}>
                  Open File Transfer
                </Button>
              </div>
            </>
          ) : (
            <Notice tone="info">File transfer wasn&apos;t allowed by the other computer.</Notice>
          )}
        </div>
      )}

      <div className="mt-6 border-2 border-nd-divider bg-nd-surface p-5">
        <p className="flex items-center gap-2 text-sm font-semibold text-nd-ok">
          <span aria-hidden className="h-2 w-2 bg-nd-ok" /> Viewer running
        </p>
        <p className="mt-2 text-sm text-nd-dim">
          {isNativeShell
            ? 'The desktop is open in its own viewer window. Disconnect here when you are done.'
            : 'Preview simulation: no real stream is running.'}
        </p>
        {!isNativeShell && (
          <p className="mt-2 border border-nd-divider px-2 py-1 text-[11px] font-semibold text-nd-dim">
            Preview — simulated session
          </p>
        )}
      </div>

      <div className="mt-6">
        <Button variant="danger" onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    </div>
  )
}
