import { Button, Notice, Switch } from '../components/ui'
import type { AccountStatus } from '../lib/useAccount'

/**
 * Screen 01 — Login. Drives the real account contract: system-browser OAuth
 * in the packaged app, a clearly labeled simulation in the browser preview.
 * Cancel leaves the user signed out without an error (AUTH-03); repeated
 * clicks never start a second attempt (AUTH-04).
 */
export default function Login({
  status,
  staySignedIn,
  onStaySignedInChange,
  onSignIn,
  onUseLocalMode,
}: {
  status: AccountStatus
  staySignedIn: boolean
  onStaySignedInChange: (v: boolean) => void
  onSignIn: () => void
  onUseLocalMode: () => void
}) {
  const busy = status.kind === 'signingIn' || status.kind === 'restoring'
  const error = status.kind === 'authError' ? status.message : status.kind === 'restoreError' ? status.message : null

  return (
    <div className="flex min-h-screen bg-nd-bg text-nd-text">
      <div className="flex flex-1 flex-col justify-between border-r-2 border-nd-divider bg-nd-surface p-10">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="block h-4 w-4 bg-nd-accent" />
          <span className="text-sm font-extrabold tracking-tight">NodeDesk</span>
        </div>
        <h1 className="max-w-md text-5xl font-extrabold leading-tight">
          Sign in once.
          <br />
          Every computer is one click away.
        </h1>
        <p className="text-sm text-nd-dim">Free remote desktop for your own computers.</p>
      </div>

      <div className="flex flex-1 items-center justify-center p-10">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-bold">Sign in</h2>
          <p className="mt-2 text-sm text-nd-dim">Use the Google account that owns your saved computers.</p>

          <div className="mt-8">
            <Button onClick={onSignIn} disabled={busy}>
              {status.kind === 'signingIn' ? 'Complete sign-in in your browser…' : 'Continue with Google'}
            </Button>
          </div>

          {error && (
            <div className="mt-4">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <label className="mt-8 flex items-center gap-3 text-sm">
            <Switch checked={staySignedIn} onChange={onStaySignedInChange} label="Stay signed in" />
            <span>
              Stay signed in
              <span className="block text-xs text-nd-dim">Skip sign-in next time you open the app.</span>
            </span>
          </label>

          <button
            onClick={onUseLocalMode}
            className="mt-10 text-sm font-semibold text-nd-accent-strong hover:underline"
          >
            Use without an account (local network mode)
          </button>
          <p className="mt-2 text-xs text-nd-dim">
            Local mode works on your home network with an access code. Account sync, saved computers on every
            device, and one-click connect need Google sign-in.
          </p>
        </div>
      </div>
    </div>
  )
}
