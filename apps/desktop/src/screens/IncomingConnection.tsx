import { useEffect, useRef, useState } from 'react'
import { api, type ConnectionRequest, type SessionPermissions } from '../lib/api'
import { Button, Notice, Switch } from '../components/ui'

/**
 * Screen 05 — Incoming Connection (host side). The requester identity,
 * New-device badge and deadline all come from the service (verified fields,
 * not requester-controlled strings — APPROVAL-01). The deadline never pauses
 * in the background (APPROVAL-03); Accept racing expiry yields one host-side
 * result (APPROVAL-04), surfaced honestly if the request is gone.
 */
export default function IncomingConnection({
  request,
  onDecided,
}: {
  request: ConnectionRequest
  onDecided: (outcome: 'accepted' | 'rejected' | 'expired') => void
}) {
  const [perms, setPerms] = useState<SessionPermissions>({
    control: false,
    files: false,
    clipboard: false,
    audio: false, // off initially, matching the permission mockup (SPEC §05)
  })
  const [trust, setTrust] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((request.deadline - Date.now()) / 1000)))
  const decidedRef = useRef(false)

  useEffect(() => {
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((request.deadline - Date.now()) / 1000))
      setRemaining(left)
      if (left <= 0 && !decidedRef.current) {
        decidedRef.current = true
        clearInterval(t)
        onDecided('expired')
      }
    }, 500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id])

  const decide = async (accept: boolean) => {
    if (busy || decidedRef.current) return
    decidedRef.current = true
    setBusy(true)
    setError(null)
    try {
      if (accept) {
        await api.acceptIncomingRequest(request.id, perms, trust)
        onDecided('accepted')
      } else {
        await api.rejectIncomingRequest(request.id)
        onDecided('rejected')
      }
    } catch {
      // Accept/expiry race resolved host-side: the request was already gone.
      setError('That request is no longer pending — it may have expired or been cancelled.')
      decidedRef.current = false
      setBusy(false)
    }
  }

  const name = request.requesterName || request.requesterLabel || 'Someone'
  const email = request.requesterEmail

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="incoming-title" className="w-full max-w-md border-2 border-nd-divider bg-nd-bg p-6 shadow-[var(--nd-shadow)]">
        <h2 id="incoming-title" className="text-lg font-bold">
          Incoming connection
        </h2>

        <div className="mt-4 flex items-center gap-3 border-2 border-nd-divider bg-nd-surface p-4">
          <span aria-hidden className="flex h-10 w-10 items-center justify-center bg-nd-accent text-sm font-extrabold text-nd-on-accent">
            {name.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{name}</p>
            {email && <p className="truncate text-xs text-nd-dim">{email}</p>}
            {request.isNewDevice && (
              <p className="mt-0.5 text-xs font-bold uppercase tracking-wide text-nd-accent-strong">New device</p>
            )}
          </div>
        </div>

        <p className="mt-4 text-xs font-bold uppercase tracking-widest text-nd-dim">Allow this person to</p>
        <div className="mt-1 divide-y divide-nd-rule border-2 border-nd-divider bg-nd-surface px-4">
          <p className="py-3 text-sm">
            <span className="font-semibold">View your screen</span>
            <span className="ml-2 text-xs text-nd-dim">Always on</span>
          </p>
          {(
            [
              ['control', 'Control keyboard and mouse'],
              ['files', 'Transfer files'],
              ['clipboard', 'Share clipboard'],
              ['audio', 'Play audio'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center justify-between py-3 text-sm">
              <span>{label}</span>
              <Switch
                checked={perms[key]}
                label={label}
                onChange={(v) => setPerms((p) => ({ ...p, [key]: v }))}
              />
            </label>
          ))}
        </div>

        {request.sameAccount && (
          <label className="mt-3 flex items-center gap-3 text-sm">
            <Switch checked={trust} onChange={setTrust} label="Trust this device for unattended access" />
            <span>
              Trust this device
              <span className="block text-xs text-nd-dim">
                It can connect without approval when unattended access is on.
              </span>
            </span>
          </label>
        )}

        <p role="status" className="mt-4 text-xs text-nd-dim">
          Request expires in <strong>{remaining}s</strong> — then it&apos;s rejected automatically.
        </p>

        {error && (
          <div className="mt-3">
            <Notice tone="error">{error}</Notice>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => void decide(false)} disabled={busy}>
            Reject
          </Button>
          <Button onClick={() => void decide(true)} disabled={busy}>
            {busy ? 'Applying…' : 'Accept'}
          </Button>
        </div>
      </div>
    </div>
  )
}
