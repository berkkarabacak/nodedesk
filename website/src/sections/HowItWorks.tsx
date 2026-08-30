import { Download, Radar, MonitorPlay } from 'lucide-react'

const steps = [
  {
    icon: Download,
    step: '01',
    title: 'Install',
    text: 'One installer per machine. It installs the app, configures the host service, firewall rules and secure device identity — automatically.',
  },
  {
    icon: Radar,
    step: '02',
    title: 'Find your computer',
    text: 'NodeDesk discovers machines on your LAN (and tailnet, if you use Tailscale). Approve pairing once — the device is trusted from then on.',
  },
  {
    icon: MonitorPlay,
    step: '03',
    title: 'Connect',
    text: 'Click Connect. Your remote desktop opens with hardware-accelerated video, synced clipboard and file transfer — no settings to tune.',
  },
]

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="border-y border-zinc-800/80 bg-zinc-900/30 py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">How it works</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Fresh PC → remote desktop in under 2 minutes
          </h2>
          <p className="mt-4 text-zinc-400">
            You will never see the words “codec”, “port” or “pairing PIN” unless you go looking for them.
          </p>
        </div>

        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <div key={s.step} className="relative rounded-2xl border border-zinc-800 bg-zinc-950/70 p-7">
              {i < steps.length - 1 && (
                <div className="absolute right-0 top-1/2 hidden h-px w-6 translate-x-full bg-zinc-700 md:block" />
              )}
              <div className="flex items-center justify-between">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/25">
                  <s.icon className="h-5 w-5 text-emerald-400" />
                </div>
                <span className="font-mono text-3xl font-bold text-zinc-800">{s.step}</span>
              </div>
              <h3 className="mt-5 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{s.text}</p>
            </div>
          ))}
        </div>

        <div className="mx-auto mt-12 max-w-3xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500">What NodeDesk asks on first run — that's it</div>
          <div className="p-5 font-mono text-sm leading-7">
            <p className="text-zinc-400">How do you want to use this computer?</p>
            <p className="text-zinc-300"><span className="text-emerald-400">›</span> Control my computers</p>
            <p className="text-zinc-300"><span className="text-emerald-400">›</span> Allow this computer to be controlled</p>
            <p className="text-zinc-300"><span className="text-emerald-400">›</span> <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">Both (recommended)</span></p>
          </div>
        </div>
      </div>
    </section>
  )
}
