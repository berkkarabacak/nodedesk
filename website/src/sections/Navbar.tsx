import { useEffect, useState } from 'react'
import { Github, Menu, X } from 'lucide-react'

const links = [
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#ai', label: 'AI Workstations' },
  { href: '#security', label: 'Security' },
  { href: '#roadmap', label: 'Roadmap' },
]

export default function Navbar() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-colors ${
        scrolled ? 'border-zinc-800 bg-zinc-950/85 backdrop-blur' : 'border-transparent'
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 ring-1 ring-zinc-800">
            <svg viewBox="0 0 32 32" className="h-5 w-5">
              <path d="M9 23V9l14 14V9" stroke="#34d399" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </span>
          <span className="text-lg font-semibold tracking-tight">NodeDesk</span>
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-400">
            open source
          </span>
        </a>

        <div className="hidden items-center gap-7 md:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="text-sm text-zinc-400 transition-colors hover:text-zinc-100">
              {l.label}
            </a>
          ))}
          <a
            href="https://github.com/berkkarabacak/nodedesk"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg bg-zinc-100 px-3.5 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
          >
            <Github className="h-4 w-4" />
            GitHub
          </a>
        </div>

        <button className="md:hidden text-zinc-300" onClick={() => setOpen(!open)} aria-label="Toggle menu">
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </nav>

      {open && (
        <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-4 md:hidden">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block py-2.5 text-sm text-zinc-300"
            >
              {l.label}
            </a>
          ))}
          <a
            href="https://github.com/berkkarabacak/nodedesk"
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex items-center gap-2 py-2.5 text-sm font-medium text-emerald-400"
          >
            <Github className="h-4 w-4" /> View on GitHub
          </a>
        </div>
      )}
    </header>
  )
}
