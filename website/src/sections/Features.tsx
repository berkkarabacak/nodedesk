import {
  ClipboardList,
  FolderSync,
  MonitorSmartphone,
  MousePointerClick,
  Network,
  Power,
} from 'lucide-react'

const features = [
  {
    icon: MousePointerClick,
    title: 'One-click everything',
    text: 'Host and controller in one installer.',
  },
  {
    icon: MonitorSmartphone,
    title: 'Full remote desktop',
    text: 'H.264, HEVC or AV1, 4K, HDR — chosen automatically.',
  },
  {
    icon: Network,
    title: 'LAN + Tailscale',
    text: 'Computers appear automatically. Never internet-exposed.',
  },
  {
    icon: FolderSync,
    title: 'File transfer',
    text: 'Send files and folders over an encrypted connection.',
  },
  {
    icon: ClipboardList,
    title: 'Clipboard sync',
    text: 'Copy here, paste there. Disable anytime.',
  },
  {
    icon: Power,
    title: 'Power control',
    text: 'Wake, sleep, restart, shutdown — from the dashboard.',
  },
]

export default function Features() {
  return (
    <section id="features" className="relative py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Features</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Serious streaming. <span className="text-zinc-500">Simple experience.</span>
          </h2>
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="group rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 transition-colors hover:border-emerald-500/40 hover:bg-zinc-900/80"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/20 transition-colors group-hover:bg-emerald-500/20">
                <f.icon className="h-5 w-5 text-emerald-400" />
              </div>
              <h3 className="mt-4 font-semibold text-zinc-100">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{f.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
