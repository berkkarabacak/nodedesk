import { KeyRound, Lock, ShieldCheck, FileWarning, Fingerprint, EyeOff } from 'lucide-react'

const items = [
  {
    icon: KeyRound,
    title: 'Authenticated pairing',
    text: 'Every device is explicitly approved before it can connect. Pairing reuses Sunshine/Moonlight’s proven certificate handshake — never weakened for convenience.',
  },
  {
    icon: Lock,
    title: 'Encrypted end to end',
    text: 'Streaming, file transfer and clipboard data all travel over encrypted channels with verified device certificates.',
  },
  {
    icon: EyeOff,
    title: 'Never internet-exposed',
    text: 'NodeDesk works on LAN by default and integrates with Tailscale for remote access. It does not silently open your host to the public internet.',
  },
  {
    icon: Fingerprint,
    title: 'Secure device identity',
    text: 'Each machine gets a generated identity stored in OS-provided secure storage (Windows Credential Manager, Keychain, libsecret).',
  },
  {
    icon: ShieldCheck,
    title: 'Simple trust model',
    text: 'A plain list of trusted computers. Revoke any device in one click — no certificate jargon required.',
  },
  {
    icon: FileWarning,
    title: 'Clean diagnostics',
    text: 'Exportable diagnostic reports never include passwords, private keys, tokens or clipboard contents.',
  },
]

export default function Security() {
  return (
    <section id="security" className="border-y border-zinc-800/80 bg-zinc-900/30 py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">Security</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Simple for you. <span className="text-zinc-500">Strict under the hood.</span>
          </h2>
          <p className="mt-4 text-zinc-400">
            No unauthenticated remote-desktop access — ever. Onboarding is easy because the hard parts are automated,
            not because the security is weaker. The full threat model lives in{' '}
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

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
