import { useEffect, useState } from 'react'
import { api, type QualityPreset, type Settings, type Theme, type TrustedController } from '../lib/api'
import type { AccountStatus } from '../lib/useAccount'
import { Button, Dialog, FieldRow, Notice, Segmented, Switch } from '../components/ui'

/** Map a quality preset onto the existing native stream settings. */
function applyPreset(s: Settings, preset: QualityPreset): Settings {
  switch (preset) {
    case 'speed':
      return { ...s, qualityPreset: preset, codec: 'h264', bitrateMbps: 15, fps: 60, resolution: '1080p', hdr: false }
    case 'balanced':
      return { ...s, qualityPreset: preset, codec: 'auto', bitrateMbps: 40, fps: 60, resolution: 'auto' }
    case 'quality':
      return { ...s, qualityPreset: preset, codec: 'auto', bitrateMbps: 80, fps: 60, resolution: 'auto' }
    default:
      return { ...s, qualityPreset: 'auto', codec: 'auto', bitrateMbps: 40, fps: 60, resolution: 'auto' }
  }
}

/**
 * Screen 08 — Settings. Every control persists through the real save_settings
 * command; theme applies immediately across all app-owned surfaces
 * (SETTINGS-02). Account/trust sections are honest about the pending M2–M4
 * account work instead of showing fixture data.
 */
export default function SettingsScreen({
  settings,
  account,
  onSignOut,
  onSwitchAccount,
  onSaveSettings,
  onThemeChange,
  onSignIn,
  onOpenDiagnostics,
}: {
  settings: Settings
  account: AccountStatus
  onSignOut: () => void
  onSwitchAccount: () => void
  onSaveSettings: (s: Settings) => Promise<void>
  onThemeChange: (t: Theme) => void
  onSignIn: () => void
  onOpenDiagnostics: () => void
}) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [trusted, setTrusted] = useState<TrustedController[] | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<TrustedController | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const signedIn = account.kind === 'signedIn'

  useEffect(() => {
    if (!signedIn) return
    api
      .listTrustedControllers()
      .then(setTrusted)
      .catch(() => setTrusted(null))
  }, [signedIn])

  const revoke = async (t: TrustedController) => {
    // TRUST-02/03: revocation is confirmed by the host side; failure keeps
    // the entry with an honest error instead of promising access has ended.
    setRevokeError(null)
    try {
      await api.revokeTrustedController(t.controllerDeviceId)
      setTrusted((prev) => prev?.filter((x) => x.controllerDeviceId !== t.controllerDeviceId) ?? null)
      setRevokeTarget(null)
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : "We couldn't revoke that device. Its access may still be active — try again.")
    }
  }

  const save = async (next: Settings) => {
    setSaveState('saving')
    try {
      await onSaveSettings(next)
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 2500)
    } catch {
      setSaveState('error')
    }
  }

  const changeTheme = (theme: Theme) => {
    // Apply immediately, then persist; failure restores truthful state (J9).
    onThemeChange(theme)
    void save({ ...settings, theme })
  }

  const isHost = settings.mode !== 'controller'

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-extrabold">Settings</h1>

      <h2 className="mt-8 text-xs font-bold uppercase tracking-widest text-nd-dim">Account</h2>
      <div className="mt-2 border-2 border-nd-divider bg-nd-surface px-5">
        {account.kind === 'signedIn' ? (
          <>
            <FieldRow label={account.profile.name} hint={account.profile.email}>
              <span className="flex gap-2">
                <Button variant="secondary" onClick={onSwitchAccount}>
                  Switch account
                </Button>
                <Button variant="secondary" onClick={onSignOut}>
                  Sign out
                </Button>
              </span>
            </FieldRow>
            <FieldRow label="Stay signed in" hint="Skip sign-in when you open the app. Turning this off removes the stored sign-in credential after this session.">
              <Switch
                checked={settings.staySignedIn !== false}
                label="Stay signed in"
                onChange={(stay) => {
                  void api.setStaySignedIn(stay)
                  void save({ ...settings, staySignedIn: stay })
                }}
              />
            </FieldRow>
          </>
        ) : (
          <>
            <FieldRow label="Google account" hint="Saved computers that sync across your devices need an account.">
              <Button variant="secondary" onClick={onSignIn}>
                Sign in
              </Button>
            </FieldRow>
            <FieldRow
              label="Stay signed in"
              hint="Skip sign-in when you open the app. Applies once an account is connected."
            >
              <Switch
                checked={settings.staySignedIn !== false}
                label="Stay signed in"
                onChange={(stay) => {
                  void api.setStaySignedIn(stay)
                  void save({ ...settings, staySignedIn: stay })
                }}
              />
            </FieldRow>
          </>
        )}
      </div>

      {isHost && (
        <>
          <h2 className="mt-8 text-xs font-bold uppercase tracking-widest text-nd-dim">Trusted computers</h2>
          <div className="mt-2 border-2 border-nd-divider bg-nd-surface px-5 py-1">
            {signedIn ? (
              trusted && trusted.length > 0 ? (
                <ul>
                  {trusted.map((t) => (
                    <li key={t.controllerDeviceId} className="flex items-center justify-between border-b border-nd-rule py-3 last:border-b-0">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{t.label || t.controllerDeviceId}</p>
                        <p className="text-xs text-nd-dim">
                          Trusted since {new Date(t.trustedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <Button variant="secondary" onClick={() => setRevokeTarget(t)}>
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-sm text-nd-dim">
                  {trusted === null ? "We couldn't load trusted computers." : 'No trusted computers yet. Accept a connection from one of your devices and choose "Trust this device".'}
                </p>
              )
            ) : (
              <p className="py-4 text-sm text-nd-dim">
                Trusted computers can connect without approval when unattended access is on. The trusted-device
                list needs account sign-in — today, pairing on your local network is managed from each computer
                directly.
              </p>
            )}
          </div>

          <h2 className="mt-8 text-xs font-bold uppercase tracking-widest text-nd-dim">Remote access</h2>
          <div className="mt-2 border-2 border-nd-divider bg-nd-surface px-5">
            <FieldRow
              label="Unattended access"
              hint="One shared policy — This Computer shows the same switch. Trusted computers only."
            >
              <Switch
                checked={Boolean(settings.unattendedAccess)}
                label="Unattended access"
                onChange={(v) => {
                  // HOST-06: one policy, persisted locally AND on the service
                  // (which enforces it); a failed service call keeps the
                  // switch truthful by reverting the local save.
                  void save({ ...settings, unattendedAccess: v })
                  if (signedIn) {
                    api.setHostPolicy(v).catch(() => void save({ ...settings, unattendedAccess: !v }))
                  }
                }}
              />
            </FieldRow>
          </div>
        </>
      )}

      <h2 className="mt-8 text-xs font-bold uppercase tracking-widest text-nd-dim">General</h2>
      <div className="mt-2 border-2 border-nd-divider bg-nd-surface px-5">
        <FieldRow label="Start with Windows" hint="Open NodeDesk when you sign in to Windows.">
          <Switch
            checked={settings.startOnBoot}
            label="Start with Windows"
            onChange={(v) => void save({ ...settings, startOnBoot: v })}
          />
        </FieldRow>
        <FieldRow
          label="Connection quality"
          hint="Applies to new sessions. You can change it during a session from the toolbar."
        >
          <Segmented<QualityPreset>
            ariaLabel="Default connection quality"
            value={settings.qualityPreset ?? 'auto'}
            onChange={(v) => void save(applyPreset(settings, v))}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'speed', label: 'Speed' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'quality', label: 'Quality' },
            ]}
          />
        </FieldRow>
        <FieldRow label="Theme" hint="Changes every NodeDesk screen.">
          <Segmented<Theme>
            ariaLabel="Theme"
            value={settings.theme === 'dark' ? 'dark' : 'light'}
            onChange={changeTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </FieldRow>
        <FieldRow label="Clipboard synchronization" hint="Copy and paste between your computers.">
          <Switch
            checked={settings.clipboardSync}
            label="Clipboard synchronization"
            onChange={(v) => void save({ ...settings, clipboardSync: v })}
          />
        </FieldRow>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button onClick={onOpenDiagnostics} className="text-sm font-semibold text-nd-accent-strong hover:underline">
          Diagnostics and advanced tools
        </button>
        <p role="status" className="text-xs text-nd-dim" aria-live="polite">
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'saved' && <span className="font-semibold text-nd-ok">Saved</span>}
          {saveState === 'error' && <span className="font-semibold text-nd-danger">Couldn&apos;t save. Try again.</span>}
        </p>
      </div>

      {revokeTarget && (
        <Dialog title={`Remove ${revokeTarget.label || 'this device'}?`} onClose={() => setRevokeTarget(null)}>
          <p className="mt-2 text-sm text-nd-dim">
            It will no longer connect without approval, and any active session from it ends. Other trusted
            computers are not affected.
          </p>
          {revokeError && (
            <div className="mt-3">
              <Notice tone="error">{revokeError}</Notice>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRevokeTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void revoke(revokeTarget)}>
              Remove
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
