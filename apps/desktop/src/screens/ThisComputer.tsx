import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { api, formatPublicId, onEvent, type AppInfo, type DeviceIdentity, type Settings } from '../lib/api'
import { Button, FieldRow, Notice, Switch } from '../components/ui'

/**
 * Screen 04 — This Computer. Native state (host status, access code,
 * bootstrap) plus, when signed in, explicit device enrollment and the
 * stable public Device ID (HOST-01/02). Enrollment never happens silently
 * and sign-in alone never enables remote access.
 */
export default function ThisComputer({
  settings,
  signedIn,
  onSaveSettings,
}: {
  settings: Settings
  signedIn: boolean
  onSaveSettings: (s: Settings) => Promise<void>
}) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [infoError, setInfoError] = useState(false)
  const [accessCode, setAccessCode] = useState('')
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null)
  const [copied, setCopied] = useState(false)
  const [setup, setSetup] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  const [setupMsg, setSetupMsg] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [enrollError, setEnrollError] = useState<string | null>(null)

  const hostingReady = Boolean(info?.sunshineInstalled && info.sunshineRunning)

  const load = async () => {
    try {
      setInfo(await api.getAppInfo())
      setInfoError(false)
    } catch {
      setInfoError(true)
    }
    if (signedIn) {
      await api
        .getDeviceIdentity()
        .then(setIdentity)
        .catch(() => {})
    }
  }

  useEffect(() => {
    void load()
    void api
      .getAccessCode()
      .then(setAccessCode)
      .catch(() => {})
    let unDone: (() => void) | undefined
    let unProg: (() => void) | undefined
    let unErr: (() => void) | undefined
    void onEvent('bootstrap-done', () => {
      setSetup('done')
      setSetupMsg('')
      void load()
    }).then((fn) => (unDone = fn))
    void onEvent('bootstrap-progress', (m) => setSetupMsg(String(m))).then((fn) => (unProg = fn))
    void onEvent('bootstrap-error', (m) => {
      setSetup('error')
      setSetupMsg(String(m))
    }).then((fn) => (unErr = fn))
    return () => {
      unDone?.()
      unProg?.()
      unErr?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])

  const enableHosting = async () => {
    if (setup === 'working') return
    setSetup('working')
    setSetupMsg('Starting host setup…')
    try {
      await api.bootstrapHost()
    } catch (e) {
      setSetup('error')
      setSetupMsg(e instanceof Error ? e.message : 'Host setup failed.')
    }
  }

  const enroll = async () => {
    if (enrolling) return
    setEnrolling(true)
    setEnrollError(null)
    try {
      // Explicit owner action: the device is enrolled to the signed-in
      // account and gets its stable public ID (HOST-02).
      setIdentity(await api.enrollDevice(info?.hostName ?? 'This computer'))
    } catch (e) {
      setEnrollError(e instanceof Error ? e.message : "We couldn't enroll this computer. Try again.")
    } finally {
      setEnrolling(false)
    }
  }

  const copyId = async () => {
    if (!identity?.publicId) return
    // "Copied" only after the clipboard write actually succeeds (SPEC §10).
    await navigator.clipboard.writeText(formatPublicId(identity.publicId))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const copyCode = async () => {
    await navigator.clipboard.writeText(accessCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const isHost = settings.mode !== 'controller'

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-extrabold">This Computer</h1>
      <p className="mt-1 text-sm text-nd-dim">Manage remote access to this computer.</p>

      {infoError && (
        <div className="mt-6">
          <Notice tone="error">
            We couldn&apos;t read this computer&apos;s status.{' '}
            <button onClick={() => void load()} className="font-bold underline">
              Retry
            </button>
          </Notice>
        </div>
      )}

      <div className="mt-6 border-2 border-nd-divider bg-nd-surface px-5">
        <FieldRow label="Status">
          {hostingReady ? (
            <span className="flex items-center gap-2 text-sm font-semibold text-nd-ok">
              <span aria-hidden className="h-2 w-2 bg-nd-ok" /> Accepting connections
            </span>
          ) : (
            <span className="text-sm font-semibold text-nd-dim">Remote access is off</span>
          )}
        </FieldRow>
        <FieldRow label="Device name">
          <span className="text-sm font-semibold">{identity?.name ?? info?.hostName ?? '…'}</span>
        </FieldRow>
        {signedIn && identity?.enrolled && identity.publicId && (
          <FieldRow label="Device ID" hint="Share this so your other devices — or someone helping you — can find this computer.">
            <span className="flex items-center gap-2">
              <span className="border-2 border-nd-divider bg-nd-bg px-3 py-1.5 font-mono text-sm tracking-widest">
                {formatPublicId(identity.publicId)}
              </span>
              <Button variant="secondary" onClick={() => void copyId()} ariaLabel="Copy Device ID">
                <Copy className="h-4 w-4" aria-hidden />
              </Button>
            </span>
          </FieldRow>
        )}
        {isHost && !signedIn && accessCode && (
          <FieldRow
            label="Access code"
            hint="In local mode this is how your other devices connect on the local network. A public Device ID arrives with account sign-in."
          >
            <span className="flex items-center gap-2">
              <span className="border-2 border-nd-divider bg-nd-bg px-3 py-1.5 font-mono text-sm tracking-widest">
                {accessCode}
              </span>
              <Button variant="secondary" onClick={() => void copyCode()} ariaLabel="Copy access code">
                <Copy className="h-4 w-4" aria-hidden />
              </Button>
            </span>
          </FieldRow>
        )}
        {copied && (
          <p role="status" className="py-1 text-xs font-semibold text-nd-ok">
            Copied
          </p>
        )}
      </div>

      {signedIn && identity && !identity.enrolled && (
        <div className="mt-6 border-2 border-nd-divider bg-nd-surface p-5">
          <p className="text-sm font-semibold">Add this computer to your account</p>
          <p className="mt-1 text-xs text-nd-dim">
            Enrolling gives this computer a stable Device ID and adds it to My Computers on all your devices.
            It does not turn on remote access by itself.
          </p>
          <div className="mt-3">
            <Button onClick={() => void enroll()} disabled={enrolling}>
              {enrolling ? 'Enrolling…' : 'Enroll this computer'}
            </Button>
          </div>
          {enrollError && (
            <div className="mt-3">
              <Notice tone="error">{enrollError}</Notice>
            </div>
          )}
        </div>
      )}

      {isHost && !hostingReady && (
        <div className="mt-6 border-2 border-nd-divider bg-nd-surface p-5">
          <p className="text-sm font-semibold">Enable remote access</p>
          <p className="mt-1 text-xs text-nd-dim">
            Sets up the streaming host on this computer. Windows may ask for your approval.
          </p>
          <div className="mt-3">
            <Button onClick={() => void enableHosting()} disabled={setup === 'working'}>
              {setup === 'working' ? 'Setting up…' : 'Enable remote access'}
            </Button>
          </div>
          {setup === 'working' && setupMsg && (
            <p role="status" className="mt-2 text-xs text-nd-dim">
              {setupMsg}
            </p>
          )}
          {setup === 'error' && (
            <div className="mt-3">
              <Notice tone="error">{setupMsg || 'Host setup failed.'}</Notice>
            </div>
          )}
          {setup === 'done' && (
            <p role="status" className="mt-2 text-xs font-semibold text-nd-ok">
              Host is ready.
            </p>
          )}
        </div>
      )}

      {isHost && (
        <div className="mt-6 border-2 border-nd-divider bg-nd-surface px-5">
          <FieldRow
            label="Unattended access"
            hint={
              hostingReady
                ? 'Let your own trusted devices connect without anyone accepting here. Enforced trusted devices arrive with account sign-in.'
                : 'Turn on remote access first.'
            }
          >
            <Switch
              checked={hostingReady && Boolean(settings.unattendedAccess)}
              disabled={!hostingReady}
              label="Unattended access"
              onChange={(v) => {
                void onSaveSettings({ ...settings, unattendedAccess: v })
                if (signedIn) {
                  api.setHostPolicy(v).catch(() => void onSaveSettings({ ...settings, unattendedAccess: !v }))
                }
              }}
            />
          </FieldRow>
        </div>
      )}
    </div>
  )
}
