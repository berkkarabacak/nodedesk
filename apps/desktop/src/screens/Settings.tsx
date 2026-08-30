import { useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import type { Settings } from '../lib/api'

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-zinc-700'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3.5">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

export default function SettingsScreen({
  settings,
  onSave,
  onBack,
}: {
  settings: Settings
  onSave: (s: Settings) => void
  onBack: () => void
}) {
  const [s, setS] = useState(settings)
  const [advanced, setAdvanced] = useState(false)

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-5 py-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>
      <h1 className="mt-4 text-xl font-bold">Settings</h1>

      <div className="mt-6 divide-y divide-zinc-800/80 rounded-2xl border border-zinc-800 bg-zinc-900/40 px-5">
        <Row label="Start NodeDesk when this computer starts" hint="Keeps the host service reachable">
          <Toggle checked={s.startOnBoot} onChange={(v) => setS({ ...s, startOnBoot: v })} />
        </Row>
        <Row label="Clipboard synchronization" hint="Text and URLs. Disable on shared machines for privacy">
          <Toggle checked={s.clipboardSync} onChange={(v) => setS({ ...s, clipboardSync: v })} />
        </Row>
        <Row label="Use Tailscale when available" hint="Reach your computers away from home, securely">
          <Toggle checked={s.tailscaleEnabled} onChange={(v) => setS({ ...s, tailscaleEnabled: v })} />
        </Row>
      </div>

      <button
        onClick={() => setAdvanced(!advanced)}
        className="mt-6 flex items-center gap-2 text-sm font-medium text-zinc-300 hover:text-zinc-100"
      >
        {advanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Advanced
        <span className="text-xs font-normal text-zinc-600">— most people never need this</span>
      </button>

      {advanced && (
        <div className="mt-3 space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <label className="block">
              <span className="text-xs text-zinc-500">Video codec</span>
              <select
                value={s.codec}
                onChange={(e) => setS({ ...s, codec: e.target.value as Settings['codec'] })}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
              >
                <option value="auto">Automatic (recommended)</option>
                <option value="av1">AV1</option>
                <option value="hevc">HEVC / H.265</option>
                <option value="h264">H.264</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500">Resolution</span>
              <select
                value={s.resolution}
                onChange={(e) => setS({ ...s, resolution: e.target.value as Settings['resolution'] })}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
              >
                <option value="auto">Match remote display</option>
                <option value="1080p">1920 × 1080</option>
                <option value="1440p">2560 × 1440</option>
                <option value="4k">3840 × 2160</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500">Bitrate: {s.bitrateMbps} Mbps</span>
              <input
                type="range"
                min={5}
                max={150}
                value={s.bitrateMbps}
                onChange={(e) => setS({ ...s, bitrateMbps: Number(e.target.value) })}
                className="mt-2 w-full accent-emerald-500"
              />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-500">Frame rate: {s.fps} FPS</span>
              <input
                type="range"
                min={30}
                max={240}
                step={30}
                value={s.fps}
                onChange={(e) => setS({ ...s, fps: Number(e.target.value) })}
                className="mt-2 w-full accent-emerald-500"
              />
            </label>
          </div>
          <Row label="HDR streaming" hint="Requires HDR-capable host and client displays">
            <Toggle checked={s.hdr} onChange={(v) => setS({ ...s, hdr: v })} />
          </Row>
          <button className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300">
            <ExternalLink className="h-3.5 w-3.5" /> Open Sunshine advanced settings
          </button>
        </div>
      )}

      <div className="mt-8 flex gap-3">
        <button
          onClick={() => onSave(s)}
          className="flex-1 rounded-xl bg-emerald-500 py-3 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"
        >
          Save
        </button>
        <button onClick={onBack} className="rounded-xl border border-zinc-700 px-6 py-3 text-sm text-zinc-300 hover:bg-zinc-900">
          Cancel
        </button>
      </div>
    </div>
  )
}
