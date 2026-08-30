import { CheckCircle2, Circle, CircleDashed } from 'lucide-react'

const mvp = [
  { done: true, text: 'Windows-first: one installer, host + controller in one app' },
  { done: true, text: 'Automatic Sunshine host configuration' },
  { done: true, text: 'Moonlight-based desktop connect / disconnect' },
  { done: true, text: 'LAN discovery + simple secure pairing' },
  { done: true, text: 'Tailscale detection and connectivity' },
  { done: true, text: 'Computer dashboard with CPU / RAM / GPU info' },
  { done: true, text: 'Clipboard text synchronization' },
  { done: true, text: 'Wake / sleep / restart / shutdown' },
  { done: true, text: 'Diagnostics with safe report export' },
  { done: true, text: 'Secure automatic updates (signed releases)' },
]

const next = [
  { state: 'next', text: 'File transfer: send/receive, drag & drop, resume' },
  { state: 'next', text: 'Integrated remote terminal' },
  { state: 'next', text: 'AI service discovery (Ollama, Open WebUI, ComfyUI…)' },
  { state: 'next', text: 'Headless virtual displays, managed automatically' },
  { state: 'later', text: 'Linux host support, then macOS controller' },
  { state: 'later', text: 'Beta / nightly update channels' },
  { state: 'later', text: 'Hardware compatibility matrix across NVIDIA / AMD / Intel' },
]

export default function Roadmap() {
  return (
    <section id="roadmap" className="py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Roadmap</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Ship a great MVP. Then go deep.</h2>
          <p className="mt-4 text-zinc-400">
            Priorities, in order: <span className="text-zinc-200">stability → security → simplicity → performance → features.</span>
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-7">
            <div className="flex items-center gap-3">
              <span className="rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">MVP 0.1</span>
              <h3 className="font-semibold">The first release</h3>
            </div>
            <ul className="mt-5 space-y-2.5">
              {mvp.map((i) => (
                <li key={i.text} className="flex items-start gap-2.5 text-sm text-zinc-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  {i.text}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-7">
            <div className="flex items-center gap-3">
              <span className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-300">0.2 → 1.0</span>
              <h3 className="font-semibold">What comes after</h3>
            </div>
            <ul className="mt-5 space-y-2.5">
              {next.map((i) => (
                <li key={i.text} className="flex items-start gap-2.5 text-sm text-zinc-300">
                  {i.state === 'next' ? (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                  ) : (
                    <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
                  )}
                  <span className={i.state === 'later' ? 'text-zinc-500' : ''}>{i.text}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3.5 text-xs leading-relaxed text-zinc-500">
              The defining test: can a non-technical person install NodeDesk on two computers and control one from the
              other without knowing what Sunshine, Moonlight, codecs, ports, VPNs or streaming protocols are? If not —
              we keep simplifying.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
