import { ArrowRight, Cpu, Download, Github, Monitor, Moon, Power } from 'lucide-react'

function ComputerCard({
  name,
  specs,
  cpu,
  gpu,
  online,
}: {
  name: string
  specs: string
  cpu?: number
  gpu?: number
  online: boolean
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-zinc-600'}`} />
          <span className="font-medium text-zinc-100">{name}</span>
        </div>
        {online ? (
          <span className="rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-400">ONLINE</span>
        ) : (
          <span className="rounded-md bg-zinc-800 px-2 py-1 text-[10px] font-medium text-zinc-500">OFFLINE</span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-zinc-500">{specs}</p>
      {online && cpu !== undefined && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <Cpu className="h-3 w-3" /> CPU {cpu}%
            <div className="h-1 flex-1 rounded-full bg-zinc-800">
              <div className="h-1 rounded-full bg-emerald-500/70" style={{ width: `${cpu}%` }} />
            </div>
          </div>
          {gpu !== undefined && (
            <div className="flex items-center gap-2 text-[11px] text-zinc-400">
              <Monitor className="h-3 w-3" /> GPU {gpu}%
              <div className="h-1 flex-1 rounded-full bg-zinc-800">
                <div className="h-1 rounded-full bg-emerald-500/70" style={{ width: `${gpu}%` }} />
              </div>
            </div>
          )}
        </div>
      )}
      <button
        className={`mt-3.5 w-full rounded-lg py-2 text-xs font-semibold tracking-wide transition-colors ${
          online
            ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
            : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
        }`}
      >
        {online ? 'CONNECT' : 'WAKE'}
      </button>
    </div>
  )
}

export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-32 pb-20 sm:pt-40">
      {/* background glow + grid */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[500px] w-[900px] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[140px]" />
        <div
          className="absolute inset-0 opacity-[0.15]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '56px 56px',
            maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black, transparent)',
          }}
        />
      </div>

      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 sm:px-6 lg:grid-cols-2">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3.5 py-1.5 text-xs text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Built on the Sunshine + Moonlight ecosystem
          </div>
          <h1 className="mt-6 text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
            Your computers.
            <br />
            One interface.
            <br />
            <span className="bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">Anywhere.</span>
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-zinc-400">
            NodeDesk is an open-source remote-computing app with the simplicity of Parsec, powered by
            Sunshine/Moonlight — designed for workstations, coding, and AI machines, not gaming.
          </p>
          <p className="mt-3 font-mono text-sm text-zinc-500">
            Install → Find your computer → Connect. <span className="text-zinc-300">Under 2 minutes.</span>
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="https://github.com/berkkarabacak/nodedesk/releases"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-400"
            >
              <Download className="h-4 w-4" />
              Download for Windows
            </a>
            <a
              href="https://github.com/berkkarabacak/nodedesk"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-xl border border-zinc-700 px-5 py-3 text-sm font-semibold text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
            >
              <Github className="h-4 w-4" />
              View on GitHub
            </a>
          </div>
          <p className="mt-4 text-xs text-zinc-600">GPL-3.0 · Windows first, Linux & macOS on the roadmap</p>
        </div>

        {/* App preview mock */}
        <div className="relative">
          <div className="absolute -inset-4 rounded-3xl bg-emerald-500/5 blur-2xl" />
          <div className="relative rounded-2xl border border-zinc-800 bg-zinc-950/90 shadow-2xl shadow-black/60">
            <div className="flex items-center gap-1.5 border-b border-zinc-800 px-4 py-3">
              <span className="h-3 w-3 rounded-full bg-zinc-700" />
              <span className="h-3 w-3 rounded-full bg-zinc-700" />
              <span className="h-3 w-3 rounded-full bg-zinc-700" />
              <span className="ml-3 text-xs font-medium tracking-widest text-zinc-500">NODEDESK — MY COMPUTERS</span>
            </div>
            <div className="space-y-3 p-4">
              <ComputerCard name="AI Workstation" specs="RTX 3090 · 64 GB RAM · Windows" cpu={14} gpu={72} online />
              <ComputerCard name="Old Laptop" specs="Intel i7 · 16 GB · Linux" cpu={8} online />
              <ComputerCard name="Bedroom PC" specs="Last seen 2 h ago" online={false} />
              <div className="flex items-center justify-between rounded-xl border border-dashed border-zinc-800 px-4 py-3 text-xs text-zinc-500">
                <span className="flex items-center gap-2">
                  <Moon className="h-3.5 w-3.5" /> 2 more computers found on your network
                </span>
                <span className="flex items-center gap-1 text-emerald-400">
                  Add <ArrowRight className="h-3 w-3" />
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2.5 text-[11px] text-zinc-600">
              <span className="flex items-center gap-1.5">
                <Power className="h-3 w-3 text-emerald-500" /> Host service: OK
              </span>
              <span>Tailscale: Connected</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
