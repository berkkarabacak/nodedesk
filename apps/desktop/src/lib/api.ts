// NodeDesk front-end API layer.
//
// In the packaged app every call is a Tauri command handled by the Rust core
// (see src-tauri/src/). In a plain browser (UI development), a deterministic
// mock backend keeps the interface fully interactive.

export type UsageMode = 'controller' | 'host' | 'both'

export interface Computer {
  id: string
  name: string
  os: string
  address: string
  via: 'lan' | 'tailscale' | 'manual'
  online: boolean
  specs: string
  cpuPct?: number
  gpuPct?: number
  gpuName?: string
  ramUsedGb?: number
  ramTotalGb?: number
  vramUsedGb?: number
  vramTotalGb?: number
  uptime?: string
  mac?: string
  hasAccessCode: boolean
  services?: AiService[]
}

export interface ManualHost {
  name: string
  address: string
  mac?: string
}

export interface Settings {
  mode: UsageMode
  startOnBoot: boolean
  clipboardSync: boolean
  tailscaleEnabled: boolean
  codec: 'auto' | 'h264' | 'hevc' | 'av1'
  bitrateMbps: number
  fps: number
  resolution: 'auto' | '1080p' | '1440p' | '4k'
  hdr: boolean
  onboarded?: boolean
  manualHosts?: ManualHost[]
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

export interface AppInfo {
  version: string
  onboarded: boolean
  mode: UsageMode
  sunshineInstalled: boolean
  sunshineRunning: boolean
  moonlightPresent: boolean
  hostName: string
}

export interface DiagnosticsItem {
  label: string
  ok: boolean
  detail?: string
}

export interface Metrics {
  hostName: string
  os: string
  cpuPct: number
  ramUsedGb: number
  ramTotalGb: number
  uptimeSecs: number
  gpu?: { name: string; utilizationPct: number; vramUsedMb: number; vramTotalMb: number }
  mac?: string
  lanIp?: string
}

export interface UpdateInfo {
  current: string
  latest: string
  updateAvailable: boolean
  url: string
}

export interface AiService {
  name: string
  running: boolean
  port: number
}

export interface FileEntry {
  name: string
  isDir: boolean
  size: number
}

export interface TerminalResult {
  ok: boolean
  output: string
  cwd: string
}

export interface TransferProgress {
  direction: 'up' | 'down'
  file: string
  doneBytes: number
  totalBytes: number
  finished: boolean
}

export interface HeadlessStatus {
  supported: boolean
  vddInstalled: boolean
  displayCount: number
}

const isTauri = '__TAURI_INTERNALS__' in window

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, args)
  }
  return mockInvoke<T>(cmd, args)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (payload: any) => void

type NodeDeskEvent = 'pair-pin' | 'bootstrap-progress' | 'bootstrap-error' | 'bootstrap-done' | 'stream-started' | 'transfer-progress'

export async function onEvent(event: NodeDeskEvent, cb: Listener): Promise<() => void> {
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen(event, (e) => cb(e.payload))
  }
  return mockListen(event, cb)
}

// ---------------------------------------------------------------------------
// Mock backend (browser preview only)
// ---------------------------------------------------------------------------

const mockComputers: Computer[] = [
  {
    id: '192.168.1.20', name: 'AI Workstation', os: 'windows', address: '192.168.1.20', via: 'lan',
    online: true, specs: 'RTX 3090 · 64 GB RAM', cpuPct: 14, gpuPct: 72, gpuName: 'NVIDIA RTX 3090',
    ramUsedGb: 41, ramTotalGb: 64, vramUsedGb: 18.2, vramTotalGb: 24, uptime: '6 d 4 h',
    mac: 'AA:BB:CC:DD:EE:01', hasAccessCode: true,
    services: [
      { name: 'Ollama', running: true, port: 11434 },
      { name: 'Open WebUI', running: true, port: 3000 },
      { name: 'ComfyUI', running: true, port: 8188 },
      { name: 'vLLM', running: false, port: 8000 },
    ],
  },
  {
    id: '192.168.1.32', name: 'Old Laptop', os: 'linux', address: '192.168.1.32', via: 'lan',
    online: true, specs: '16 GB RAM', cpuPct: 8, ramUsedGb: 5.1, ramTotalGb: 16,
    uptime: '2 d 11 h', hasAccessCode: true,
  },
  {
    id: '192.168.1.44', name: 'Bedroom PC', os: 'windows', address: '192.168.1.44', via: 'manual',
    online: false, specs: 'Added manually', mac: 'AA:BB:CC:DD:EE:02', hasAccessCode: false,
  },
]

let mockSettings: Settings = { ...defaultSettings }
let mockOnboarded = false

const mockListeners: Record<string, Listener[]> = {}

function mockListen(event: string, cb: Listener): Promise<() => void> {
  mockListeners[event] = [...(mockListeners[event] ?? []), cb]
  return Promise.resolve(() => {
    mockListeners[event] = (mockListeners[event] ?? []).filter((l) => l !== cb)
  })
}

function mockEmit(event: string, payload: unknown) {
  for (const cb of mockListeners[event] ?? []) cb(payload)
}

function delay(ms = 300) {
  return new Promise((r) => setTimeout(r, ms))
}

async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await delay()
  switch (cmd) {
    case 'get_app_info':
      return {
        version: '1.0.0-mock', onboarded: mockOnboarded || localStorage.getItem('nodedesk.onboarded') === 'yes',
        mode: mockSettings.mode, sunshineInstalled: true, sunshineRunning: true,
        moonlightPresent: true, hostName: 'Demo-PC',
      } as T
    case 'complete_onboarding': {
      mockSettings = { ...mockSettings, mode: args?.mode as UsageMode }
      mockOnboarded = true
      localStorage.setItem('nodedesk.onboarded', 'yes')
      if (mockSettings.mode !== 'controller') {
        mockEmit('bootstrap-progress', 'Installing Sunshine host…')
        setTimeout(() => mockEmit('bootstrap-progress', 'Sunshine ready (v27.0)'), 900)
        setTimeout(() => mockEmit('bootstrap-progress', 'Securing host…'), 1600)
        setTimeout(() => mockEmit('bootstrap-done', 'true'), 2300)
      } else {
        setTimeout(() => mockEmit('bootstrap-done', 'true'), 400)
      }
      return undefined as T
    }
    case 'bootstrap_host':
      setTimeout(() => mockEmit('bootstrap-done', 'true'), 800)
      return undefined as T
    case 'list_computers':
      return structuredClone(mockComputers) as T
    case 'add_manual_host':
      return 'Demo-Host' as T
    case 'forget_host': {
      const address = args?.address as string
      const index = mockComputers.findIndex((c) => c.address === address)
      if (index >= 0) mockComputers.splice(index, 1)
      return undefined as T
    }
    case 'pair_computer':
      setTimeout(() => mockEmit('pair-pin', '1234'), 900)
      await delay(3000)
      return undefined as T
    case 'approve_pairing':
      return undefined as T
    case 'connect_computer':
      setTimeout(() => mockEmit('stream-started', String(args?.address ?? '')), 300)
      return undefined as T
    case 'disconnect_computer':
    case 'power_action':
    case 'wake_computer':
      return undefined as T
    case 'run_diagnostics':
      return [
        { label: 'Host service', ok: true, detail: 'Sunshine host is running' },
        { label: 'Host API', ok: true, detail: 'Local Sunshine API responding' },
        { label: 'Controller', ok: true, detail: 'Moonlight client ready' },
        { label: 'GPU', ok: true, detail: 'NVIDIA RTX 3090 detected' },
        { label: 'Network', ok: true, detail: 'LAN address 192.168.1.10' },
        { label: 'Tailscale', ok: true, detail: 'Installed' },
      ] as T
    case 'export_diagnostics':
      return 'C:\\Users\\demo\\nodedesk-diagnostics.txt' as T
    case 'get_settings':
      return { ...mockSettings, onboarded: true } as T
    case 'save_settings':
      mockSettings = { ...mockSettings, ...(args?.settings as Partial<Settings>) }
      return undefined as T
    case 'get_access_code':
      return 'K7MX-29QF' as T
    case 'regenerate_access_code':
      return 'T4BN-77XA' as T
    case 'check_update':
      return { current: '1.0.0', latest: '1.0.0', updateAvailable: false, url: '' } as T
    case 'local_metrics':
      return { hostName: 'Demo-PC', os: 'windows', cpuPct: 9, ramUsedGb: 12.4, ramTotalGb: 32, uptimeSecs: 92000 } as T
    case 'list_files':
      return [
        { name: 'Documents', isDir: true, size: 0 },
        { name: 'models', isDir: true, size: 0 },
        { name: 'notes.txt', isDir: false, size: 1842 },
        { name: 'render-final.mp4', isDir: false, size: 734003200 },
      ] as T
    case 'send_files': {
      const paths = (args?.paths as string[]) ?? []
      let done = 0
      const total = 734003200
      const timer = setInterval(() => {
        done += total / 8
        mockEmit('transfer-progress', {
          direction: 'up', file: paths[0]?.split(/[\\/]/).pop() ?? 'file',
          doneBytes: Math.min(done, total), totalBytes: total, finished: done >= total,
        })
        if (done >= total) clearInterval(timer)
      }, 250)
      await delay(2200)
      return undefined as T
    }
    case 'download_file':
      return 'C:\\Users\\demo\\Downloads\\NodeDesk\\render-final.mp4' as T
    case 'cancel_transfer':
      return undefined as T
    case 'headless_status':
      return { supported: true, vddInstalled: false, displayCount: 1 } as T
    case 'enable_headless':
      await delay(1500)
      return undefined as T
    case 'terminal_exec': {
      const command = String(args?.command ?? '')
      const cwd = String(args?.cwd ?? '') || 'C:\\Users\\demo'
      return {
        ok: true,
        output: command === 'ls' || command === 'dir' ? 'Documents  models  notes.txt  render-final.mp4' : `(mock) ran: ${command}`,
        cwd: command.startsWith('cd ') ? `${cwd}\\${command.slice(3)}` : cwd,
      } as T
    }
    default:
      throw new Error(`Unknown command: ${cmd}`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const api = {
  getAppInfo: () => invoke<AppInfo>('get_app_info'),
  completeOnboarding: (mode: UsageMode) => invoke<void>('complete_onboarding', { mode }),
  bootstrapHost: () => invoke<void>('bootstrap_host'),
  listComputers: () => invoke<Computer[]>('list_computers'),
  addManualHost: (address: string, code: string) => invoke<string>('add_manual_host', { address, code }),
  forgetHost: (address: string) => invoke<void>('forget_host', { address }),
  approvePairing: (pin: string) => invoke<void>('approve_pairing', { pin }),
  pairComputer: (address: string) => invoke<void>('pair_computer', { address }),
  connect: (address: string) => invoke<void>('connect_computer', { address }),
  disconnect: () => invoke<void>('disconnect_computer'),
  power: (address: string, action: 'sleep' | 'restart' | 'shutdown' | 'lock') =>
    invoke<void>('power_action', { address, action }),
  wake: (address: string) => invoke<void>('wake_computer', { address }),
  localMetrics: () => invoke<Metrics>('local_metrics'),
  runDiagnostics: () => invoke<DiagnosticsItem[]>('run_diagnostics'),
  exportDiagnostics: () => invoke<string>('export_diagnostics'),
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),
  getAccessCode: () => invoke<string>('get_access_code'),
  regenerateAccessCode: () => invoke<string>('regenerate_access_code'),
  checkUpdate: () => invoke<UpdateInfo>('check_update'),
  listFiles: (address: string, path: string) => invoke<FileEntry[]>('list_files', { address, path }),
  sendFiles: (address: string, paths: string[]) => invoke<void>('send_files', { address, paths }),
  downloadFile: (address: string, path: string) => invoke<string>('download_file', { address, path }),
  cancelTransfer: () => invoke<void>('cancel_transfer'),
  terminalExec: (address: string, command: string, cwd: string) =>
    invoke<TerminalResult>('terminal_exec', { address, command, cwd }),
  headlessStatus: () => invoke<HeadlessStatus>('headless_status'),
  enableHeadless: () => invoke<void>('enable_headless'),
}
