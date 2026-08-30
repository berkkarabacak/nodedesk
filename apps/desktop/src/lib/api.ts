// NodeDesk front-end API layer.
//
// In the packaged desktop app, every call is forwarded to the Rust core via
// Tauri commands (see src-tauri/src/main.rs). When the UI runs in a plain
// browser (development / design preview), a deterministic mock backend keeps
// the interface fully interactive.

export type UsageMode = 'controller' | 'host' | 'both'

export interface Computer {
  id: string
  name: string
  os: 'Windows' | 'Linux' | 'macOS'
  online: boolean
  specs: string
  cpuPct?: number
  gpuPct?: number
  ramUsedGb?: number
  ramTotalGb?: number
  vramUsedGb?: number
  vramTotalGb?: number
  network?: string
  uptime?: string
  services?: AiService[]
}

export interface AiService {
  name: string
  running: boolean
  url?: string
}

export interface DiagnosticsItem {
  label: string
  ok: boolean
  detail?: string
}

export interface Settings {
  mode: UsageMode
  startOnBoot: boolean
  clipboardSync: boolean
  tailscaleEnabled: boolean
  // Advanced
  codec: 'auto' | 'h264' | 'hevc' | 'av1'
  bitrateMbps: number
  fps: number
  resolution: 'auto' | '1080p' | '1440p' | '4k'
  hdr: boolean
}

export const defaultSettings: Settings = {
  mode: 'both',
  startOnBoot: true,
  clipboardSync: true,
  tailscaleEnabled: true,
  codec: 'auto',
  bitrateMbps: 40,
  fps: 60,
  resolution: 'auto',
  hdr: false,
}

const isTauri = '__TAURI_INTERNALS__' in window

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, args)
  }
  return mockInvoke<T>(cmd, args)
}

// ---------------------------------------------------------------------------
// Mock backend (browser preview only — never shipped logic)
// ---------------------------------------------------------------------------

const mockComputers: Computer[] = [
  {
    id: 'ai-workstation',
    name: 'AI Workstation',
    os: 'Windows',
    online: true,
    specs: 'RTX 3090 · 64 GB RAM',
    cpuPct: 14,
    gpuPct: 72,
    ramUsedGb: 41,
    ramTotalGb: 64,
    vramUsedGb: 18.2,
    vramTotalGb: 24,
    network: 'LAN · 940 Mbps · 3 ms',
    uptime: '6 d 4 h',
    services: [
      { name: 'Ollama', running: true, url: 'http://ai-workstation:11434' },
      { name: 'Open WebUI', running: true, url: 'http://ai-workstation:3000' },
      { name: 'ComfyUI', running: true, url: 'http://ai-workstation:8188' },
      { name: 'Jupyter', running: false },
    ],
  },
  {
    id: 'old-laptop',
    name: 'Old Laptop',
    os: 'Linux',
    online: true,
    specs: 'Intel i7 · 16 GB',
    cpuPct: 8,
    ramUsedGb: 5.1,
    ramTotalGb: 16,
    network: 'LAN · 210 Mbps · 6 ms',
    uptime: '2 d 11 h',
    services: [{ name: 'Ollama', running: false }],
  },
  {
    id: 'bedroom-pc',
    name: 'Bedroom PC',
    os: 'Windows',
    online: false,
    specs: 'Last seen 2 h ago',
  },
]

const mockDiagnostics: DiagnosticsItem[] = [
  { label: 'Host', ok: true, detail: 'NodeDesk host service running' },
  { label: 'Streaming service', ok: true, detail: 'Sunshine-compatible host active' },
  { label: 'GPU encoder', ok: true, detail: 'NVENC HEVC available' },
  { label: 'Network', ok: true, detail: 'LAN reachable' },
  { label: 'Tailscale', ok: true, detail: 'Connected — 3 nodes reachable' },
  { label: 'Firewall', ok: true, detail: 'Rules configured by installer' },
]

let mockSettings: Settings = { ...defaultSettings }

function delay(ms = 250) {
  return new Promise((r) => setTimeout(r, ms))
}

async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await delay()
  switch (cmd) {
    case 'list_computers':
      return structuredClone(mockComputers) as T
    case 'run_diagnostics':
      return structuredClone(mockDiagnostics) as T
    case 'get_settings':
      return { ...mockSettings } as T
    case 'save_settings':
      mockSettings = { ...mockSettings, ...(args?.settings as Partial<Settings>) }
      return { ...mockSettings } as T
    case 'connect_computer':
    case 'wake_computer':
    case 'power_action':
    case 'export_diagnostics':
      return { ok: true } as T
    default:
      throw new Error(`Unknown command: ${cmd}`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const api = {
  listComputers: () => invoke<Computer[]>('list_computers'),
  connect: (id: string) => invoke<{ ok: boolean }>('connect_computer', { id }),
  disconnect: (id: string) => invoke<{ ok: boolean }>('disconnect_computer', { id }),
  wake: (id: string) => invoke<{ ok: boolean }>('wake_computer', { id }),
  power: (id: string, action: 'sleep' | 'restart' | 'shutdown' | 'lock') =>
    invoke<{ ok: boolean }>('power_action', { id, action }),
  runDiagnostics: () => invoke<DiagnosticsItem[]>('run_diagnostics'),
  exportDiagnostics: () => invoke<{ ok: boolean }>('export_diagnostics'),
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<Settings>('save_settings', { settings }),
}
