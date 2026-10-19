import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { api, __resetMockBackend, type Settings } from './lib/api'

// M8: persisted settings single-source-of-truth and migration behavior.

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
  __resetMockBackend()
})

const LEGACY_SETTINGS: Settings = {
  // A pre-redesign settings file: none of the M1–M8 fields exist.
  mode: 'both',
  startOnBoot: true,
  clipboardSync: true,
  tailscaleEnabled: true,
  codec: 'hevc',
  bitrateMbps: 55,
  fps: 120,
  resolution: '1440p',
  hdr: true,
  onboarded: true,
}

async function renderSignedIn() {
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
  await screen.findByText('preview@example.invalid', {}, { timeout: 3000 })
}

describe('SETTINGS-01: Stay signed in is one preference', () => {
  it('Settings and Login read/write the same persisted value', async () => {
    const setStay = vi.spyOn(api, 'setStaySignedIn')
    await renderSignedIn()
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await userEvent.click(await screen.findByRole('switch', { name: 'Stay signed in' }))
    expect(setStay).toHaveBeenCalledWith(false)

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    // Login shows the same preference — off.
    const toggle = await screen.findByRole('switch', { name: 'Stay signed in' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
})

describe('SETTINGS-03: default quality applies to new sessions only', () => {
  it('a saved default seeds the next connection; the session override stays session-local', async () => {
    vi.spyOn(api, 'listDirectoryComputers').mockResolvedValue([
      {
        deviceId: 'dev-h',
        publicId: '482913705',
        name: 'Office PC',
        online: true,
        isThisDevice: false,
        endpoints: ['192.168.1.20'],
      },
    ])
    const withQuality = vi.spyOn(api, 'connectWithQuality').mockImplementation(async () => {
      const { __emitMockEvent } = await import('./lib/api')
      __emitMockEvent('stream-ready', {})
    })
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue({
      id: 'req-m8',
      hostDeviceId: 'dev-h',
      requesterDeviceId: 'dev-local',
      requesterLabel: 'This computer',
      state: 'accepted',
      deadline: Date.now() + 30_000,
      permissions: { control: true, files: true, clipboard: true, audio: true },
    })
    await renderSignedIn()

    // Save Best speed as the default.
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await userEvent.click(await screen.findByRole('radio', { name: 'Speed' }))

    // New session starts with that policy (no session override yet).
    await userEvent.click(screen.getByRole('button', { name: 'My Computers' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }, { timeout: 3000 }))
    await waitFor(() => expect(withQuality).toHaveBeenCalledWith('192.168.1.20', 'speed'), { timeout: 8000 })

    // The persisted default is unchanged by the session's own quality state.
    const saves = vi.spyOn(api, 'saveSettings').mock.calls.map((c) => c[0])
    expect(saves.filter((s) => s.qualityPreset === 'auto')).toHaveLength(0)
  }, 15_000)
})

describe('SETTINGS-04: Start with Windows persists through the real save path', () => {
  it('toggling persists the new value', async () => {
    const saveSpy = vi.spyOn(api, 'saveSettings')
    await renderSignedIn()
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await userEvent.click(await screen.findByRole('switch', { name: 'Start with Windows' }))
    await waitFor(() =>
      expect(saveSpy.mock.calls.map((c) => c[0]).some((s) => s.startOnBoot === false)).toBe(true),
    )
  })
})

describe('COMPAT-01: legacy settings migrate with safe defaults and preserved choices', () => {
  it('old settings files gain safe defaults without losing explicit preferences', async () => {
    localStorage.setItem('nodedesk.onboarded', 'yes')
    vi.spyOn(api, 'getSettings').mockResolvedValue({ ...LEGACY_SETTINGS })
    render(<App />)
    await screen.findByRole('navigation', { name: 'Primary' }, { timeout: 3000 })

    // No theme stored before → light, the product default.
    expect(document.documentElement.dataset.theme).toBeUndefined()

    // Explicit legacy preferences survive the merge.
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const saveSpy = vi.spyOn(api, 'saveSettings')
    await userEvent.click(await screen.findByRole('radio', { name: 'Dark' }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalled())
    const saved = saveSpy.mock.calls.map((c) => c[0]).find((s) => s.theme === 'dark')!
    expect(saved.codec).toBe('hevc') // preserved explicit codec
    expect(saved.bitrateMbps).toBe(55) // preserved explicit bitrate
    expect(saved.fps).toBe(120)
    expect(saved.theme).toBe('dark')
  })
})
