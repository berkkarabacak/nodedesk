import { ArrowUpRight, Bug, Github, HeartHandshake, MessageSquare, Sparkles } from 'lucide-react'

export default function Community() {
  return (
    <section className="border-t border-zinc-800/80 py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-gradient-to-b from-zinc-900/80 to-zinc-950 p-8 sm:p-12">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Open source</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                Standing on Sunshine & Moonlight's shoulders
              </h2>
              <p className="mt-4 leading-relaxed text-zinc-400">
                NodeDesk wraps their streaming tech in a product anyone can use. Fixes go upstream.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <a
                  href="https://github.com/berkkarabacak/nodedesk"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-xl bg-zinc-100 px-5 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white"
                >
                  <Github className="h-4 w-4" /> Star on GitHub
                </a>
                <a
                  href="https://github.com/berkkarabacak/nodedesk/blob/main/CONTRIBUTING.md"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-xl border border-zinc-700 px-5 py-3 text-sm font-semibold text-zinc-200 transition-colors hover:bg-zinc-900"
                >
                  <HeartHandshake className="h-4 w-4 text-emerald-400" /> Contribute
                </a>
              </div>
            </div>

            <div className="grid content-center gap-3">
              {[
                { icon: Bug, label: 'Report a bug', href: 'https://github.com/berkkarabacak/nodedesk/issues/new?template=bug_report.yml' },
                { icon: Sparkles, label: 'Request a feature', href: 'https://github.com/berkkarabacak/nodedesk/issues/new?template=feature_request.yml' },
                { icon: MessageSquare, label: 'Join the discussions', href: 'https://github.com/berkkarabacak/nodedesk/discussions' },
                { icon: HeartHandshake, label: 'Good first issues', href: 'https://github.com/berkkarabacak/nodedesk/labels/good%20first%20issue' },
              ].map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-5 py-4 transition-colors hover:border-emerald-500/40"
                >
                  <span className="flex items-center gap-3 text-sm font-medium text-zinc-200">
                    <l.icon className="h-4 w-4 text-emerald-400" />
                    {l.label}
                  </span>
                  <ArrowUpRight className="h-4 w-4 text-zinc-600 transition-colors group-hover:text-emerald-400" />
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
