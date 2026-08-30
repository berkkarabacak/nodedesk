import { Github } from 'lucide-react'

export default function Footer() {
  return (
    <footer className="border-t border-zinc-800/80 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-4 sm:px-6 md:flex-row md:items-center">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-zinc-900 ring-1 ring-zinc-800">
              <svg viewBox="0 0 32 32" className="h-4 w-4">
                <path d="M9 23V9l14 14V9" stroke="#34d399" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </span>
            <span className="font-semibold">NodeDesk</span>
          </div>
          <p className="mt-3 text-sm text-zinc-500">Your computers. One interface. Anywhere. GPL-3.0.</p>
        </div>

        <div className="flex flex-wrap gap-x-8 gap-y-3 text-sm text-zinc-400">
          <a href="https://github.com/berkkarabacak/nodedesk" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-zinc-100">
            <Github className="h-4 w-4" /> Repository
          </a>
          <a href="https://github.com/berkkarabacak/nodedesk/blob/main/docs/architecture.md" target="_blank" rel="noreferrer" className="hover:text-zinc-100">Architecture</a>
          <a href="https://github.com/berkkarabacak/nodedesk/blob/main/SECURITY.md" target="_blank" rel="noreferrer" className="hover:text-zinc-100">Security policy</a>
        </div>
      </div>
      <div className="mx-auto mt-10 max-w-6xl px-4 sm:px-6">
        <p className="text-xs leading-relaxed text-zinc-600">
          Built on Sunshine (LizardByte) and Moonlight, both GPL-3.0. Not affiliated with either project.
        </p>
      </div>
    </footer>
  )
}
