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
  /** Current verified/hinted route (LAN/tailnet endpoint) when known. */
  endpoint?: string
  services?: AiService[]
}

export interface ManualHost {
  name: string
  address: string
  mac?: string
}

export type Theme = 'light' | 'dark'

/** Quality presets shown in Settings (Screen 08). They map onto the existing
 * native codec/bitrate/fps settings; a session may override them (M6). */
export type QualityPreset = 'auto' | 'speed' | 'balanced' | 'quality'

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
  // --- UI redesign additions (additive migration: absent = safe default) ---
  /** Light default for new installs; an explicit existing value is preserved. */
  theme?: Theme
  /** New-session quality preset. 'auto' when unset. */
  qualityPreset?: QualityPreset
  /** Host policy. Enforcement requires trusted-controller grants (M4); until
   * then the saved value alone never creates effective access (SPEC §05). */
  unattendedAccess?: boolean
  /** True once the user explicitly picks account-less local network mode on
   * the Login screen. Local mode never inherits cloud permissions (SPEC §08). */
  localMode?: boolean
  /** One persisted preference shared by Login and Settings (SETTINGS-01).
   * Off = no durable restoration credential is retained (AUTH-05). */
  staySignedIn?: boolean
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
  theme: 'light',
  qualityPreset: 'auto',
  unattendedAccess: false,
  localMode: false,
  staySignedIn: true,
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

/** M7 queue event/record. Correlation is by transferId, never by filename
 * (FILE-04). Progress is acknowledged bytes of total (FILE-03). */
export type TransferState =
  | 'queued'
  | 'transferring'
  | 'interrupted'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface TransferItem {
  transferId: string
  direction: 'up' | 'down'
  file: string
  address: string
  doneBytes: number
  totalBytes: number
  state: TransferState
}

export type ConflictPolicy = 'keep-both' | 'overwrite'

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

type NodeDeskEvent =
  | 'pair-pin'
  | 'bootstrap-progress'
  | 'bootstrap-error'
  | 'bootstrap-done'
  | 'stream-started'
  | 'stream-exited'
  | 'transfer-progress'

export async function onEvent(event: NodeDeskEvent, cb: Listener): Promise<() => void> {
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen(event, (e) => cb(e.payload))
  }
  return mockListen(event, cb)
}

// ---------------------------------------------------------------------------
// Account contract. In the packaged app these are Tauri commands backed by
// the native google_auth module (system-browser OAuth + PKCE, tokens in the
// OS keychain, identity verified by the directory service). In the browser
// preview they are deterministic simulations and the shell labels them as
// such — a simulated sign-in can never satisfy AUTH-02.
// ---------------------------------------------------------------------------

export interface AccountProfile {
  /** Stable account key: provider issuer + subject, never just email text. */
  accountId: string
  email: string
  name: string
}

export type AuthState = { state: 'signedOut' } | { state: 'signedIn'; profile: AccountProfile }

export type SignInResult =
  | { outcome: 'signedIn'; profile: AccountProfile }
  | { outcome: 'cancelled' }
  | { outcome: 'notConfigured'; reason: string }

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

const initialMockComputers = structuredClone(mockComputers)

let mockSettings: Settings = { ...defaultSettings }
let mockOnboarded = false
// Generation guard: mock invocations that are still in flight when a test
// resets the backend must not mutate state belonging to the next test.
let mockGeneration = 0

/** Test-only reset: restores the mock backend to a clean first-install state. */
export function __resetMockBackend() {
  mockGeneration += 1
  mockSettings = { ...defaultSettings }
  mockOnboarded = false
  mockStaySignedIn = true
  mockDirectory = []
  mockNextPublicId = 482913705
  mockUnattended = false
  mockPending = []
  mockTrusted = []
  mockRequestSeq = 0
  mockSimulatedRequestAt = null
  mockRequests.clear()
  mockTransfers.clear()
  mockTransferSeq = 0
  mockSessionClipboard = false
  mockClipboardOut = ''
  mockComputers.length = 0
  mockComputers.push(...structuredClone(initialMockComputers))
  for (const key of Object.keys(mockListeners)) delete mockListeners[key]
}

// Simulated account state for the browser preview. Never reachable in a
// packaged build (mockInvoke only runs without __TAURI_INTERNALS__).
const MOCK_ACCOUNT: AccountProfile = {
  accountId: 'preview:000000000000000000000',
  email: 'preview@example.invalid',
  name: 'Preview User',
}

// Preview device identity + directory. The local device ID is stable across
// reloads (localStorage), like the real config-dir persistence.
interface MockDevice {
  deviceId: string
  publicId: string
  name: string
  online: boolean | 'unknown'
}

let mockDirectory: MockDevice[] = []
let mockNextPublicId = 482913705
// M4 preview state: host policy, pending requests, trusted controllers.
let mockUnattended = false
let mockPending: ConnectionRequest[] = []
let mockTrusted: TrustedController[] = []
let mockRequestSeq = 0
let mockSimulatedRequestAt: number | null = null
const mockRequests = new Map<string, ConnectionRequest>()
let mockTransferSeq = 0
const mockTransfers = new Map<string, TransferItem>()
let mockSessionClipboard = false
let mockClipboardOut = ''

function mockLocalDeviceId(): string {
  let id = localStorage.getItem('nodedesk.preview.deviceId')
  if (!id) {
    id = 'preview-device-' + Math.random().toString(36).slice(2, 10)
    localStorage.setItem('nodedesk.preview.deviceId', id)
  }
  return id
}

function mockLocalDevice(): MockDevice | null {
  const raw = localStorage.getItem('nodedesk.preview.device')
  return raw ? (JSON.parse(raw) as MockDevice) : null
}

function mockStoredSession(): AccountProfile | null {
  return localStorage.getItem('nodedesk.preview.session') === 'yes' ? MOCK_ACCOUNT : null
}

// The mock's stay-signed-in preference: a durable session is only written
// when it is on (mirrors the native keychain-vs-memory behavior).
let mockStaySignedIn = true

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
  const generation = mockGeneration
  await delay()
  const stale = () => generation !== mockGeneration
  switch (cmd) {
    case 'get_app_info':
      return {
        version: '1.0.0-mock', onboarded: mockOnboarded || localStorage.getItem('nodedesk.onboarded') === 'yes',
        mode: mockSettings.mode, sunshineInstalled: true, sunshineRunning: true,
        moonlightPresent: true, hostName: 'Demo-PC',
      } as T
    case 'complete_onboarding': {
      if (stale()) return undefined as T
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
      mockEmit('stream-exited', true)
      return undefined as T
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
      if (!stale()) mockSettings = { ...mockSettings, ...(args?.settings as Partial<Settings>) }
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
      if (stale()) return [] as T
      const paths = (args?.paths as string[]) ?? []
      const ids: string[] = []
      for (const p of paths) {
        const file = p.split(/[\\/]/).pop() ?? 'file'
        const id = 'mock-t-' + ++mockTransferSeq
        const total = file === 'empty.bin' ? 0 : 734003200
        const item: TransferItem = {
          transferId: id, direction: 'up', file, address: String(args?.address ?? ''),
          doneBytes: 0, totalBytes: total, state: 'queued',
        }
        mockTransfers.set(id, item)
        ids.push(id)
        // Serial simulated progress, 4 steps per file, per-transfer ID.
        let step = 0
        const timer = setInterval(() => {
          if (stale()) { clearInterval(timer); return }
          const cur = mockTransfers.get(id)
          if (!cur || cur.state === 'cancelled') { clearInterval(timer); return }
          step++
          cur.state = 'transferring'
          cur.doneBytes = Math.min(cur.totalBytes, Math.round((cur.totalBytes * step) / 4))
          mockEmit('transfer-progress', { ...cur })
          if (step >= 4 || cur.totalBytes === 0) {
            clearInterval(timer)
            cur.doneBytes = cur.totalBytes
            cur.state = 'completed'
            mockEmit('transfer-progress', { ...cur })
          }
        }, 300)
      }
      return ids as T
    }
    case 'download_file': {
      const id = 'mock-t-' + ++mockTransferSeq
      const file = String(args?.path ?? '').split(/[\\/]/).pop() ?? 'file'
      const item: TransferItem = {
        transferId: id, direction: 'down', file, address: String(args?.address ?? ''),
        doneBytes: 0, totalBytes: 734003200, state: 'queued',
      }
      mockTransfers.set(id, item)
      let step = 0
      const timer = setInterval(() => {
        if (stale()) { clearInterval(timer); return }
        const cur = mockTransfers.get(id)
        if (!cur || cur.state === 'cancelled') { clearInterval(timer); return }
        step++
        cur.state = 'transferring'
        cur.doneBytes = Math.min(cur.totalBytes, Math.round((cur.totalBytes * step) / 4))
        mockEmit('transfer-progress', { ...cur })
        if (step >= 4) {
          clearInterval(timer)
          cur.state = 'completed'
          mockEmit('transfer-progress', { ...cur })
        }
      }, 300)
      return id as T
    }
    case 'cancel_transfer': {
      const t = mockTransfers.get(String(args?.transferId ?? ''))
      if (t && t.state !== 'completed') {
        t.state = 'cancelled'
        mockEmit('transfer-progress', { ...t })
      }
      return undefined as T
    }
    case 'retry_transfer': {
      const t = mockTransfers.get(String(args?.transferId ?? ''))
      if (!t) throw new Error('No transfer with that ID.')
      if (t.state !== 'interrupted' && t.state !== 'failed' && t.state !== 'cancelled') {
        throw new Error('Only an interrupted transfer can be retried.')
      }
      t.state = 'transferring'
      let step = Math.max(1, Math.round((t.doneBytes / Math.max(1, t.totalBytes)) * 4))
      const id = t.transferId
      const timer = setInterval(() => {
        if (stale()) { clearInterval(timer); return }
        const cur = mockTransfers.get(id)
        if (!cur || cur.state === 'cancelled') { clearInterval(timer); return }
        step++
        cur.doneBytes = Math.min(cur.totalBytes, Math.round((cur.totalBytes * step) / 4))
        mockEmit('transfer-progress', { ...cur })
        if (step >= 4) {
          clearInterval(timer)
          cur.state = 'completed'
          mockEmit('transfer-progress', { ...cur })
        }
      }, 300)
      return undefined as T
    }
    case 'list_transfers':
      return [...mockTransfers.values()].map((t) => ({ ...t })) as T
    case 'agent_cert_fingerprint':
      return 'a1b2c3d4e5f6'.padEnd(64, '0') as T
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
    // --- Simulated account/directory commands (preview only) ---
    case 'auth_get_state': {
      const profile = mockStoredSession()
      return (profile ? { state: 'signedIn', profile } : { state: 'signedOut' }) as T
    }
    case 'auth_sign_in': {
      // Simulates a completed provider round-trip in the preview. A durable
      // session is written only when stay-signed-in is on (AUTH-05).
      if (stale()) return { outcome: 'cancelled' } as T
      if (mockStaySignedIn) localStorage.setItem('nodedesk.preview.session', 'yes')
      return { outcome: 'signedIn', profile: MOCK_ACCOUNT } as T
    }
    case 'auth_sign_out': {
      if (!stale()) localStorage.removeItem('nodedesk.preview.session')
      return undefined as T
    }
    case 'auth_set_stay_signed_in': {
      if (stale()) return undefined as T
      mockStaySignedIn = args?.stay !== false
      if (!mockStaySignedIn) localStorage.removeItem('nodedesk.preview.session')
      return undefined as T
    }
    case 'dir_list_computers': {
      // Real contract: the account-scoped saved list. The LAN fixtures above
      // belong to local mode and are never mixed into the account directory.
      if (!mockStoredSession()) throw new Error('Not signed in')
      const localId = mockLocalDeviceId()
      return mockDirectory.map((d) => ({
        deviceId: d.deviceId,
        publicId: d.publicId,
        name: d.name,
        online: d.online,
        isThisDevice: d.deviceId === localId,
      })) as T
    }
    case 'device_get_identity': {
      const local = mockLocalDevice()
      return {
        deviceId: mockLocalDeviceId(),
        name: 'Demo-PC',
        enrolled: Boolean(local),
        publicId: local?.publicId,
      } as T
    }
    case 'device_enroll': {
      if (!mockStoredSession()) throw new Error('Not signed in')
      if (stale()) return undefined as T
      const existing = mockLocalDevice()
      if (existing) {
        if (!mockDirectory.some((d) => d.deviceId === existing.deviceId)) mockDirectory.push(existing)
        return { deviceId: existing.deviceId, name: existing.name, enrolled: true, publicId: existing.publicId } as T
      }
      const device: MockDevice = {
        deviceId: mockLocalDeviceId(),
        publicId: String(mockNextPublicId++).padStart(9, '0'),
        name: String(args?.name ?? 'Demo-PC'),
        online: true,
      }
      localStorage.setItem('nodedesk.preview.device', JSON.stringify(device))
      mockDirectory.push(device)
      return { deviceId: device.deviceId, name: device.name, enrolled: true, publicId: device.publicId } as T
    }
    case 'device_heartbeat':
      return undefined as T
    case 'dir_resolve_device_id': {
      if (!mockStoredSession()) throw new Error('Not signed in')
      const id = String(args?.publicId ?? '').replace(/\s/g, '')
      const found = mockDirectory.find((d) => d.publicId === id)
      if (!/^[0-9]{9}$/.test(id)) throw new Error('A Device ID is nine digits, like 482 913 705.')
      if (!found) throw new Error('No computer with that ID. Check the number on the other computer.')
      return { deviceId: found.deviceId, publicId: found.publicId, name: found.name, online: found.online } as T
    }
    case 'dir_add_computer': {
      if (!mockStoredSession()) throw new Error('Not signed in')
      if (stale()) return undefined as T
      const id = String(args?.publicId ?? '').replace(/\s/g, '')
      if (mockDirectory.some((d) => d.publicId === id)) throw new Error('That computer is already in your list.')
      const device: MockDevice = {
        deviceId: 'remote-' + id,
        publicId: id,
        name: String(args?.name ?? ''),
        online: 'unknown',
      }
      mockDirectory.push(device)
      return { ...device, isThisDevice: false } as T
    }
    case 'dir_rename_computer': {
      if (stale()) return undefined as T
      const device = mockDirectory.find((d) => d.deviceId === args?.deviceId)
      if (!device) throw new Error('That computer is not in your list.')
      const name = String(args?.name ?? '').trim()
      if (!name) throw new Error('Enter a name.')
      device.name = name
      const local = mockLocalDevice()
      if (local && local.deviceId === device.deviceId) {
        localStorage.setItem('nodedesk.preview.device', JSON.stringify({ ...local, name }))
      }
      return undefined as T
    }
    case 'dir_remove_computer': {
      if (stale()) return undefined as T
      const index = mockDirectory.findIndex((d) => d.deviceId === args?.deviceId)
      if (index >= 0) mockDirectory.splice(index, 1)
      return undefined as T
    }
    // --- M4 preview: approval + trust ---
    case 'host_get_policy':
      if (!mockStoredSession()) throw new Error('Not signed in')
      return { unattended: mockUnattended } as T
    case 'host_set_policy':
      if (!mockStoredSession()) throw new Error('Not signed in')
      if (!stale()) mockUnattended = args?.unattended === true
      return undefined as T
    case 'host_pending_requests': {
      if (!mockStoredSession()) throw new Error('Not signed in')
      // Deterministic preview: one simulated helper request arrives ~6 s
      // after the host first polls. Clearly a simulation (preview badge).
      if (mockSimulatedRequestAt === null && mockLocalDevice()) mockSimulatedRequestAt = Date.now() + 6000
      if (mockSimulatedRequestAt !== null && Date.now() >= mockSimulatedRequestAt) {
        mockSimulatedRequestAt = null
        mockPending.push({
          id: 'preview-req-' + ++mockRequestSeq,
          hostDeviceId: mockLocalDeviceId(),
          requesterDeviceId: 'preview-helper-device',
          requesterLabel: "Daniel's MacBook Pro (simulated)",
          requesterEmail: 'daniel@example.invalid',
          requesterName: 'Daniel Reyes (simulated)',
          isNewDevice: true,
          sameAccount: false,
          state: 'pending',
          deadline: Date.now() + 30_000,
          permissions: { control: false, files: false, clipboard: false, audio: false },
        })
      }
      const now = Date.now()
      mockPending = mockPending.filter((r) => r.state === 'pending' && r.deadline > now)
      return structuredClone(mockPending) as T
    }
    case 'host_accept_request': {
      const req = mockPending.find((r) => r.id === args?.id && r.state === 'pending' && r.deadline > Date.now())
      if (!req) throw new Error('That request is no longer pending.')
      const perms = args?.permissions as SessionPermissions
      req.state = 'accepted'
      req.permissions = { ...perms }
      if (args?.trust === true && req.sameAccount) {
        mockTrusted.push({ controllerDeviceId: req.requesterDeviceId, label: req.requesterLabel, trustedAt: Date.now() })
      }
      return structuredClone(req) as T
    }
    case 'host_reject_request': {
      const req = mockPending.find((r) => r.id === args?.id && r.state === 'pending')
      if (!req) throw new Error('That request is no longer pending.')
      req.state = 'rejected'
      return undefined as T
    }
    case 'request_create': {
      if (!mockStoredSession()) throw new Error('Not signed in')
      const hostId = String(args?.hostDeviceId ?? '')
      const target = mockDirectory.find((d) => d.deviceId === hostId)
      if (!target) throw new Error('No computer with that ID in your list.')
      if (target.online !== true) throw new Error(`We couldn't reach ${target.name}. It may be offline.`)
      // Preview simulation: the (simulated) remote host auto-accepts after a
      // short wait, like a trusted owner device with unattended access.
      const req: ConnectionRequest = {
        id: 'preview-session-' + ++mockRequestSeq,
        hostDeviceId: hostId,
        requesterDeviceId: mockLocalDeviceId(),
        requesterLabel: 'This computer',
        state: 'pending',
        deadline: Date.now() + 30_000,
        permissions: { control: true, files: true, clipboard: true, audio: true },
      }
      mockRequests.set(req.id, req)
      const id = req.id
      setTimeout(() => {
        const r = mockRequests.get(id)
        if (r && r.state === 'pending') r.state = 'accepted'
      }, 2000)
      return structuredClone(req) as T
    }
    case 'request_status': {
      const req = mockRequests.get(String(args?.id ?? ''))
      if (!req) throw new Error('not_found')
      return structuredClone(req) as T
    }
    case 'request_cancel': {
      const req = mockRequests.get(String(args?.id ?? ''))
      if (req && (req.state === 'pending' || req.state === 'accepted')) req.state = 'cancelled'
      return undefined as T
    }
    case 'request_end': {
      const req = mockRequests.get(String(args?.id ?? ''))
      if (req && req.state === 'accepted') req.state = 'ended'
      return undefined as T
    }
    case 'trust_list':
      if (!mockStoredSession()) throw new Error('Not signed in')
      return structuredClone(mockTrusted) as T
    case 'trust_revoke': {
      if (stale()) return undefined as T
      const i = mockTrusted.findIndex((t) => t.controllerDeviceId === args?.controllerDeviceId)
      if (i >= 0) mockTrusted.splice(i, 1)
      return undefined as T
    }
    // --- M6 preview: session controls ---
    case 'session_list_displays':
      // One real display in the preview — a second is never invented.
      return [{ index: 1, resolution: '1920 × 1080', primary: true }] as T
    case 'session_stats':
      // The interim external viewer cannot report measurements: null, and
      // the UI shows placeholders instead of constants (TOOLBAR-04).
      return null as T
    case 'session_clipboard':
      if (!stale()) mockSessionClipboard = args?.enabled === true
      return undefined as T
    case 'session_clipboard_send':
      if (!mockSessionClipboard) throw new Error('Clipboard sharing is off for this session.')
      mockClipboardOut = String(args?.text ?? '')
      return undefined as T
    case 'session_clipboard_receive':
      if (!mockSessionClipboard) throw new Error('Clipboard sharing is off for this session.')
      return mockClipboardOut as T
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
  sendFiles: (address: string, paths: string[], onConflict?: ConflictPolicy) =>
    invoke<string[]>('send_files', { address, paths, onConflict }),
  /** Returns the transfer ID; the saved path arrives via the completed
   * transfer event (Done only after verified completion — FILE-03). */
  downloadFile: (address: string, path: string, onConflict?: ConflictPolicy) =>
    invoke<string>('download_file', { address, path, onConflict }),
  cancelTransfer: (transferId: string) => invoke<void>('cancel_transfer', { transferId }),
  retryTransfer: (transferId: string) => invoke<void>('retry_transfer', { transferId }),
  listTransfers: () => invoke<TransferItem[]>('list_transfers'),
  terminalExec: (address: string, command: string, cwd: string) =>
    invoke<TerminalResult>('terminal_exec', { address, command, cwd }),
  headlessStatus: () => invoke<HeadlessStatus>('headless_status'),
  /** Local agent TLS fingerprint (SHA-256, hex) for out-of-band verification. */
  agentCertFingerprint: () => invoke<string>('agent_cert_fingerprint'),
  enableHeadless: () => invoke<void>('enable_headless'),
  // Account lifecycle (native google_auth module; simulated in preview).
  getAuthState: () => invoke<AuthState>('auth_get_state'),
  signInWithGoogle: () => invoke<SignInResult>('auth_sign_in'),
  signOut: () => invoke<void>('auth_sign_out'),
  setStaySignedIn: (stay: boolean) => invoke<void>('auth_set_stay_signed_in', { stay }),
  /** Account-scoped saved-computer directory. Requires a signed-in account;
   * the service enforces isolation (SECURITY-01). */
  listDirectoryComputers: () => invoke<SavedComputer[]>('dir_list_computers'),
  /** Stable local device identity (persisted in the app config dir). */
  getDeviceIdentity: () => invoke<DeviceIdentity>('device_get_identity'),
  /** Explicitly enroll this device to the signed-in account (HOST-02). */
  enrollDevice: (name: string) => invoke<DeviceIdentity>('device_enroll', { name }),
  /** Public-ID lookup: metadata only, never an access grant (DEVICE-03). */
  resolveDeviceId: (publicId: string) => invoke<ResolvedDevice>('dir_resolve_device_id', { publicId }),
  addSavedComputer: (publicId: string, name: string) =>
    invoke<SavedComputer>('dir_add_computer', { publicId, name }),
  renameSavedComputer: (deviceId: string, name: string) =>
    invoke<void>('dir_rename_computer', { deviceId, name }),
  removeSavedComputer: (deviceId: string) => invoke<void>('dir_remove_computer', { deviceId }),
  /** Presence heartbeat for the enrolled local device (called periodically
   * by the shell while signed in and hosting). */
  deviceHeartbeat: () => invoke<void>('device_heartbeat'),
  // --- M6: session controls ---
  /** Real accessible displays on the session target. Never fabricates
   * entries — a one-display host returns one entry (TOOLBAR-02). */
  listRemoteDisplays: (deviceId: string) => invoke<RemoteDisplay[]>('session_list_displays', { deviceId }),
  /** Live measurements from the active session, or null when the interim
   * external viewer cannot provide them — the UI shows honest placeholders
   * (TOOLBAR-04). */
  getSessionStats: () => invoke<SessionStats | null>('session_stats'),
  /** Quality override for a session (re)launch. With the interim external
   * viewer, changing quality requires a controlled restart — there is no
   * silent label-only switch (TOOLBAR-03). */
  connectWithQuality: (address: string, quality: QualityPreset) =>
    invoke<void>('connect_computer', { address, quality }),
  /** NodeDesk's own clipboard channel for the session (TOOLBAR-05/06).
   * The viewer's built-in clipboard follows the viewer's own behavior. */
  setSessionClipboard: (enabled: boolean) => invoke<void>('session_clipboard', { enabled }),
  sendClipboard: (text: string) => invoke<void>('session_clipboard_send', { text }),
  receiveClipboard: () => invoke<string>('session_clipboard_receive'),
  // --- M4: approval + trust ---
  getHostPolicy: () => invoke<{ unattended: boolean }>('host_get_policy'),
  setHostPolicy: (unattended: boolean) => invoke<void>('host_set_policy', { unattended }),
  listPendingRequests: () => invoke<ConnectionRequest[]>('host_pending_requests'),
  acceptIncomingRequest: (id: string, permissions: SessionPermissions, trust: boolean) =>
    invoke<ConnectionRequest>('host_accept_request', { id, permissions, trust }),
  rejectIncomingRequest: (id: string) => invoke<void>('host_reject_request', { id }),
  createConnectionRequest: (hostDeviceId: string, label: string) =>
    invoke<ConnectionRequest>('request_create', { hostDeviceId, label }),
  getRequestStatus: (id: string) => invoke<ConnectionRequest>('request_status', { id }),
  cancelConnectionRequest: (id: string) => invoke<void>('request_cancel', { id }),
  endConnectionRequest: (id: string) => invoke<void>('request_end', { id }),
  listTrustedControllers: () => invoke<TrustedController[]>('trust_list'),
  revokeTrustedController: (controllerDeviceId: string) =>
    invoke<void>('trust_revoke', { controllerDeviceId }),
}

/** Account-scoped saved computer as returned by the directory service.
 * Identity is stable and independent of the current network route (SPEC §05). */
export interface SavedComputer {
  deviceId: string
  publicId: string
  name: string
  online: boolean | 'unknown'
  isThisDevice: boolean
  /** Self-reported route hints (LAN/tailnet), account members only. */
  endpoints?: string[]
}

/** Local device identity: a stable client-generated ID, plus the public
 * nine-digit lookup ID once enrolled (HOST-01). */
export interface DeviceIdentity {
  deviceId: string
  name: string
  enrolled: boolean
  publicId?: string
}

export interface ResolvedDevice {
  deviceId: string
  publicId: string
  name: string
  online: boolean | 'unknown'
}

/** Session capabilities granted by the host. Screen viewing is implied by
 * any accepted desktop session; these are the toggleable capabilities. */
export interface SessionPermissions {
  control: boolean
  files: boolean
  clipboard: boolean
  audio: boolean
}

export type RequestState = 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled' | 'ended'

export interface ConnectionRequest {
  id: string
  hostDeviceId: string
  requesterDeviceId: string
  requesterLabel: string
  requesterEmail?: string
  requesterName?: string
  /** Verified by the service (trust record), not a display string. */
  isNewDevice?: boolean
  /** True only when requester and host share the owner account (APPROVAL-10). */
  sameAccount?: boolean
  state: RequestState
  /** Host-issued deadline, ms epoch. */
  deadline: number
  permissions: SessionPermissions
}

export interface TrustedController {
  controllerDeviceId: string
  label: string
  trustedAt: number
}

export interface RemoteDisplay {
  index: number
  resolution: string
  primary: boolean
}

/** Measured live statistics; every field optional because the interim
 * external viewer cannot provide them (TOOLBAR-04). */
export interface SessionStats {
  resolution?: string
  fps?: number
  latencyMs?: number
}

/** Group a nine-digit ID as 3-3-3 for display (leading zeroes preserved). */
export function formatPublicId(id: string): string {
  return id.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3')
}

/** True when running inside the real Tauri shell; false in a plain browser
 * preview, where the mock backend produces simulated data. The shell uses
 * this to label preview mode visibly (SPEC §11). */
export const isNativeShell = isTauri
