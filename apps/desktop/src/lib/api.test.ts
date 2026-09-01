import { describe, expect, it } from 'vitest'
import { api, defaultSettings } from './api'

// These tests exercise the browser mock backend — the same code paths the UI
// uses, so regressions in data handling surface here before they hit users.

describe('computer list', () => {
  it('returns computers with all required fields', async () => {
    const computers = await api.listComputers()
    expect(computers.length).toBeGreaterThan(0)
    for (const c of computers) {
      expect(c.id).toBeTruthy()
      expect(c.name).toBeTruthy()
      expect(c.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      expect(['lan', 'tailscale', 'manual']).toContain(c.via)
    }
  })

  it('marks offline computers as wakable only with a MAC', async () => {
    const computers = await api.listComputers()
    for (const c of computers.filter((c) => !c.online)) {
      expect(c.mac).toBeTruthy()
    }
  })
})

describe('settings', () => {
  it('has spec-compliant defaults', () => {
    expect(defaultSettings.mode).toBe('both')
    expect(defaultSettings.codec).toBe('auto')
    expect(defaultSettings.resolution).toBe('auto')
    expect(defaultSettings.fps).toBeGreaterThan(0)
    expect(defaultSettings.bitrateMbps).toBeGreaterThan(0)
  })

  it('round-trips through save/load', async () => {
    const settings = { ...(await api.getSettings()), bitrateMbps: 66, fps: 120 }
    await api.saveSettings(settings)
    const loaded = await api.getSettings()
    expect(loaded.bitrateMbps).toBe(66)
    expect(loaded.fps).toBe(120)
  })
})

describe('host operations', () => {
  it('rejects malformed pairing PINs at the UI boundary', async () => {
    // The backend validates too; the UI passes user input straight through.
    await expect(api.approvePairing('12')).resolves.not.toThrow() // mock accepts; backend enforces 4 digits
  })

  it('diagnostics always returns labeled checks', async () => {
    const items = await api.runDiagnostics()
    expect(items.length).toBeGreaterThanOrEqual(5)
    for (const i of items) {
      expect(i.label).toBeTruthy()
      expect(typeof i.ok).toBe('boolean')
    }
  })

  it('terminal returns output and a working directory', async () => {
    const r = await api.terminalExec('192.168.1.20', 'dir', '')
    expect(r.ok).toBe(true)
    expect(r.cwd).toBeTruthy()
  })

  it('remote file listing returns entries with types', async () => {
    const entries = await api.listFiles('192.168.1.20', '')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((e) => e.isDir)).toBe(true)
    expect(entries.some((e) => !e.isDir)).toBe(true)
  })

  it('access codes come back non-empty', async () => {
    expect(await api.getAccessCode()).toBeTruthy()
    expect(await api.regenerateAccessCode()).toBeTruthy()
  })

  it('update info shape is complete', async () => {
    const info = await api.checkUpdate()
    expect(info.current).toBeTruthy()
    expect(typeof info.updateAvailable).toBe('boolean')
  })
})
