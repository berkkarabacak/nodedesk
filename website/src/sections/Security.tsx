import { KeyRound, ShieldCheck, FileWarning, RefreshCcw } from 'lucide-react'

const items = [
  {
    icon: KeyRound,
    title: 'Authenticated pairing',
    text: 'Both devices approve once. Certificates do the rest.',
  },
  {
    icon: ShieldCheck,
    title: 'One-click revoke',
    text: 'A plain list of trusted computers. Remove any device instantly.',
  },
  {
    icon: FileWarning,
    title: 'Safe diagnostics',
    text: 'Reports never include passwords, keys or clipboard data.',
  },
  {
    icon: RefreshCcw,
    title: 'Signed updates',
    text: 'Unsigned updates never run.',
  },
]

export default function Security() {
  return (
    <section id="security" className="border-y border-zinc-800/80 bg-zinc-900/30 py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Security</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Simple for you. <span className="text-zinc-500">Strict underneath.</span>
          </h2>
          <p className="mt-4 text-zinc-400">
            Encrypted sessions, keys in OS secure storage, never internet-exposed. Full model:{' '}
            <a
              href="https://github.com/berkkarabacak/nodedesk/blob/main/docs/security.md"
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 underline decoration-emerald-400/40 underline-offset-4 hover:text-emerald-300"
            >
              docs/security.md
            </a>
            .
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((i) => (
            <div key={i.title} className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-6">
              <i.icon className="h-5 w-5 text-emerald-400" />
              <h3 className="mt-3.5 font-semibold">{i.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{i.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
