import {
  FolderSync,
  Gauge,
  MonitorSmartphone,
  MousePointerClick,
  Network,
  ClipboardList,
  Power,
  TerminalSquare,
  Wand2,
} from 'lucide-react'

const features = [
  {
    icon: MousePointerClick,
    title: 'One-click everything',
    text: 'One installer, one app. Host and controller in a single download — no separate Sunshine/Moonlight setup, no pairing PINs to decipher.',
  },
  {
    icon: MonitorSmartphone,
    title: 'Full remote desktop',
    text: 'Hardware H.264 / HEVC / AV1, 4K, HDR, high refresh — automatically tuned to your GPU and network. NVIDIA, AMD and Intel supported.',
  },
  {
    icon: Network,
    title: 'LAN discovery + Tailscale',
    text: 'Computers on your network appear automatically. If Tailscale is installed, NodeDesk finds your machines across the tailnet. Never exposed to the public internet.',
  },
  {
    icon: FolderSync,
    title: 'File transfer built in',
    text: 'Send files and folders, drag & drop, resume interrupted transfers — over the same authenticated, encrypted connection. No extra tools.',
  },
  {
    icon: ClipboardList,
    title: 'Clipboard sync',
    text: 'Copy on one machine, paste on another. Text and URLs at launch, with images and files under investigation. Can be disabled for privacy.',
  },
  {
    icon: Power,
    title: 'Power management',
    text: 'Wake-on-LAN, sleep, restart, shutdown and lock from the dashboard. Wake a sleeping desktop before you connect.',
  },
  {
    icon: Gauge,
    title: 'Live system insight',
    text: 'CPU, RAM, GPU and VRAM at a glance — with automatic detection of NVIDIA/AMD/Intel hardware. Metrics stay out of your way until you want them.',
  },
  {
    icon: TerminalSquare,
    title: 'Remote terminal',
    text: 'An optional integrated terminal for technical users — SSH on Linux, secure agent-based shell on Windows. Hidden unless you need it.',
  },
  {
    icon: Wand2,
    title: 'Automatic configuration',
    text: 'First run detects GPU, encoders, displays, network and host capabilities, then picks sensible defaults. Advanced settings exist — 95% of users never open them.',
  },
]

export default function Features() {
  return (
    <section id="features" className="relative py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Features</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            The streaming tech is serious.
            <br />
            <span className="text-zinc-500">The experience isn't.</span>
          </h2>
          <p className="mt-4 text-zinc-400">
            NodeDesk hides codecs, ports, certificates and firewall rules behind one calm dashboard — while the
            battle-tested Sunshine/Moonlight stack does the heavy lifting underneath.
          </p>
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
