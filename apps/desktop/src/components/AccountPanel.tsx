import type { AccountStatus } from '../lib/api'

export default function AccountPanel({
  status,
  busy,
  error,
  onSignIn,
  onSignOut,
  onLink,
}: {
  status: AccountStatus
  busy: boolean
  error: string
  onSignIn: () => void
  onSignOut: () => void
  onLink: () => void
}) {
  return (
    <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <p className="text-sm font-medium">Account</p>
      {status.signedIn ? (
        <>
          <p className="mt-1 text-sm text-zinc-200">Signed in as {status.email}</p>
          <p className="mt-1 text-xs text-zinc-400">
            {status.linked ? 'This computer is linked' : 'This computer is not linked'}
          </p>
          {!status.linked && status.registryConfigured && (
            <button
              onClick={onLink}
              disabled={busy}
              className="mt-3 rounded-lg bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-700 disabled:opacity-40"
            >
              {busy ? 'Linking…' : 'Link this computer'}
            </button>
          )}
          {status.signedIn && !status.registryConfigured && !status.linked && (
            <p className="mt-2 text-xs text-zinc-500">
              An account service address is needed before other computers can see this one.
            </p>
          )}
          <button
            onClick={onSignOut}
            disabled={busy}
            className="mt-3 block text-xs text-zinc-400 underline-offset-2 hover:text-zinc-100 hover:underline disabled:opacity-40"
          >
            Sign out
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-zinc-500">
            Sign in to see computers on your account, including ones that aren't on this network.
          </p>
          <button
            onClick={onSignIn}
            disabled={!status.configured || busy}
            className="mt-3 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40"
          >
            {busy ? 'Waiting for Google…' : 'Sign in with Google'}
          </button>
          {!status.configured && (
            <p className="mt-2 text-xs text-zinc-500">Sign-in isn't set up on this computer yet.</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  )
}
