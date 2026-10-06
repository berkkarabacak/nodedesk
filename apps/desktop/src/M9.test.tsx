import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnection } from './lib/useConnection'
import { api, __resetMockBackend, type ConnectionRequest } from './lib/api'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// M9: routing honesty (NETWORK-03) and the free-product guarantee (FREE-01).

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  __resetMockBackend()
  localStorage.setItem('nodedesk.preview.session', 'yes')
})

function acceptedRequest(): ConnectionRequest {
  return {
    id: 'req-1',
    hostDeviceId: 'dev-h',
    requesterDeviceId: 'dev-c1',
    requesterLabel: 'Home Laptop',
    state: 'accepted',
    deadline: Date.now() + 30_000,
    permissions: { control: true, files: true, clipboard: true, audio: true },
  }
}

describe('NETWORK-03: no usable route gives honest guidance', () => {
  it('a granted request without a verified route fails with remedies, never fake Connected', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(acceptedRequest())
    const connect = vi.spyOn(api, 'connect').mockResolvedValue()
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30 }))

    await act(() => result.current.start({ deviceId: 'dev-h', name: 'Office PC' })) // no endpoint
    expect(result.current.state.kind).toBe('failed')
    const s = result.current.state as { message: string }
    expect(s.message).toMatch(/couldn't reach Office PC/)
    expect(s.message).toMatch(/same network|Tailscale/)
    expect(connect).not.toHaveBeenCalled() // no viewer launch without a route
  })
})

describe('FREE-01: no artificial paid barriers', () => {
  it('no pricing/trial/subscription UI exists in the app source', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx|css)$/.test(entry) && !entry.endsWith('.test.tsx') && !entry.endsWith('.test.ts')) files.push(full)
      }
    }
    walk(join(__dirname))
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n').toLowerCase()
    // Commercial gating vocabulary, not engineering terms like event
    // "subscribe()" which are legitimately used by the event layer.
    for (const banned of ['subscription', 'trial expires', 'trial period', 'upgrade to pro', 'pricing', 'premium plan', 'paywall', 'per month', 'buy now']) {
      expect(all).not.toContain(banned)
    }
  })
})
