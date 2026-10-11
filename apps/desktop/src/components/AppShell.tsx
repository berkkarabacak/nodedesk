import type { ReactNode } from 'react'
import { Computer, FileDown, MonitorCog, Settings as SettingsIcon } from 'lucide-react'
import { isNativeShell } from '../lib/api'

export type ShellScreen = 'my-computers' | 'this-computer' | 'file-transfer' | 'settings'

const NAV: { id: ShellScreen; label: string; icon: typeof Computer }[] = [
  { id: 'my-computers', label: 'My Computers', icon: Computer },
  { id: 'this-computer', label: 'This Computer', icon: MonitorCog },
  { id: 'file-transfer', label: 'File Transfer', icon: FileDown },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
]

/**
 * Shared app shell (Screens 02/04/07/08): sidebar navigation, account
 * summary, and the active screen. The account area is honest about local
 * mode until real sign-in lands in M2.
 */
export default function AppShell({
  active,
  onNavigate,
  accountEmail,
  children,
}: {
  active: ShellScreen
  onNavigate: (s: ShellScreen) => void
  /** Verified account email, or undefined in local mode. */
  accountEmail?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen bg-nd-bg text-nd-text">
      <aside className="flex w-60 shrink-0 flex-col border-r-2 border-nd-divider bg-nd-surface">
        <div className="flex items-center gap-2.5 border-b-2 border-nd-divider px-5 py-4">
          <span aria-hidden className="block h-4 w-4 bg-nd-accent" />
          <span className="text-sm font-extrabold tracking-tight">NodeDesk</span>
        </div>

        <nav aria-label="Primary" className="flex-1 py-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              aria-current={active === id ? 'page' : undefined}
              className={`flex w-full items-center gap-3 px-5 py-3 text-left text-sm font-semibold transition-colors ${
                active === id ? 'bg-nd-bg text-nd-text' : 'text-nd-dim hover:bg-nd-bg/60 hover:text-nd-text'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </button>
          ))}
        </nav>

        <div className="border-t-2 border-nd-divider px-5 py-4">
          {accountEmail ? (
            <>
              <p className="truncate text-sm font-semibold" title={accountEmail}>
                {accountEmail}
              </p>
              <p className="text-xs text-nd-dim">Signed in</p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold">Local mode</p>
              <p className="text-xs text-nd-dim">Not signed in — LAN computers only</p>
            </>
          )}
          {!isNativeShell && (
            <p className="mt-2 border border-nd-divider px-2 py-1 text-[11px] font-semibold text-nd-dim">
              Preview — simulated data
            </p>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-8 py-6">{children}</main>
    </div>
  )
}
