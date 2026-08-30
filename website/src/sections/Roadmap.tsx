import { CheckCircle2, Circle } from 'lucide-react'

const mvp = [
  'Windows installer: host + controller in one app',
  'Automatic Sunshine setup',
  'LAN discovery, simple pairing',
  'Tailscale support',
  'Dashboard with CPU / RAM / GPU',
  'Clipboard sync, power actions, diagnostics',
]

const next = [
  'File transfer with drag & drop and resume',
  'Remote terminal',
  'AI service discovery',
  'Linux and macOS',
]

export default function Roadmap() {
  return (
    <section id="roadmap" className="py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Roadmap</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">v1.0 is out. Now we go deep.</h2>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-7">
            <div className="flex items-center gap-3">
              <span className="rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">v1.0</span>
              <h3 className="font-semibold">Shipping now</h3>
            </div>
            <ul className="mt-5 space-y-2.5">
              {mvp.map((text) => (
                <li key={text} className="flex items-start gap-2.5 text-sm text-zinc-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  {text}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-7">
            <div className="flex items-center gap-3">
              <span className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-300">Next</span>
              <h3 className="font-semibold">Coming next</h3>
            </div>
            <ul className="mt-5 space-y-2.5">
              {next.map((text) => (
                <li key={text} className="flex items-start gap-2.5 text-sm text-zinc-300">
                  <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
