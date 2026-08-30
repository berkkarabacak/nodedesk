import { ArrowUpRight, BrainCircuit } from 'lucide-react'

const services = [
  { name: 'Ollama', status: true },
  { name: 'Open WebUI', status: true },
  { name: 'ComfyUI', status: true },
  { name: 'vLLM', status: false },
]

export default function AISection() {
  return (
    <section id="ai" className="py-24">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 sm:px-6 lg:grid-cols-2">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">AI workstations</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Made for the machine with the big GPU
          </h2>
          <p className="mt-4 leading-relaxed text-zinc-400">
            GPU and VRAM on the dashboard. Headless boxes get a virtual display. Ollama, Open WebUI and ComfyUI
            detection planned.
          </p>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
              <span className="font-semibold">AI-PC</span>
            </div>
            <BrainCircuit className="h-5 w-5 text-emerald-400" />
          </div>
          <p className="mt-1 text-xs text-zinc-500">NVIDIA RTX 3090 · 24 GB VRAM</p>

          <div className="mt-5 space-y-3">
            {[
              { label: 'GPU', value: '84%', pct: 84 },
              { label: 'VRAM', value: '18.2 / 24 GB', pct: 76 },
              { label: 'RAM', value: '41 / 64 GB', pct: 64 },
              { label: 'CPU', value: '27%', pct: 27 },
            ].map((m) => (
              <div key={m.label} className="flex items-center gap-3 text-xs">
                <span className="w-11 font-mono text-zinc-400">{m.label}</span>
                <div className="h-1.5 flex-1 rounded-full bg-zinc-800">
                  <div
                    className={`h-1.5 rounded-full ${m.pct > 70 ? 'bg-amber-400/80' : 'bg-emerald-500/80'}`}
                    style={{ width: `${m.pct}%` }}
                  />
                </div>
                <span className="w-20 text-right font-mono text-zinc-300">{m.value}</span>
              </div>
            ))}
          </div>

          <div className="mt-6 border-t border-zinc-800 pt-5">
            <p className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Services</p>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              {services.map((s) => (
                <div
                  key={s.name}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5"
                >
                  <span className="flex items-center gap-2 text-sm text-zinc-200">
                    <span className={`h-2 w-2 rounded-full ${s.status ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                    {s.name}
                  </span>
                  {s.status && <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500" />}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
