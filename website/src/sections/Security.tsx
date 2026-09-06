import { KeyRound, ShieldCheck, FileLock2, Signature } from 'lucide-react'

/**
 * Every claim here must be backed by something in docs/security.md marked
 * "Implemented". This section previously advertised "Signed updates / Unsigned
 * updates never run" and "Certificates do the rest", neither of which was true:
 * v1.x releases are unsigned, and the agent channel is authenticated by HMAC,
 * not certificates. A security reviewer who finds one false claim discounts the
 * whole page, so the known gap is stated here rather than left to be discovered.
 */
const items = [
  {
    icon: KeyRound,
    title: 'Authenticated pairing',
    text: "Both devices approve once, backed by Sunshine's certificate handshake.",
  },
  {
    icon: Signature,
    title: 'Signed requests',
    text: 'Every agent request is HMAC-signed, replay-protected and throttled. The access code is never sent over the wire.',
  },
  {
    icon: FileLock2,
    title: 'Confined file access',
    text: 'Paths arriving from the network are resolved and confined. Reads stay in your own folders, writes in the transfer folder.',
  },
  {
    icon: ShieldCheck,
    title: 'One-click revoke',
    text: 'A plain list of trusted computers. Remove any device and its code stops working immediately, with no restart.',
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
            Streaming is encrypted by Sunshine and Moonlight, access codes live in OS secure storage,
            and NodeDesk never exposes a host to the public internet.
          </p>
          <p className="mt-3 text-zinc-400">
            One caveat we would rather you read here than discover later: the agent channel is signed
            and tamper-evident, but its payloads are{' '}
            <span className="text-zinc-200">not yet encrypted</span>, and v1.x binaries are unsigned.
            Run it over Tailscale on any network you do not trust. Both are covered in{' '}
            <a
              href="https://github.com/berkkarabacak/nodedesk/blob/main/docs/security.md"
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 underline decoration-emerald-400/40 underline-offset-4 hover:text-emerald-300"
            >
              docs/security.md
            </a>
            , which marks every unbuilt item as planned rather than describing it as a mechanism.
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
