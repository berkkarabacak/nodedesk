import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnection } from './lib/useConnection'
import { api, __emitMockEvent, __resetMockBackend, type ConnectionRequest } from './lib/api'

// M5: connection state machine (SESSION-01/03/04/05/06/09 at contract level,
// with injected fast timers). Real two-machine verification stays BLOCKED.

const TARGET = { deviceId: 'dev-h', name: 'Office PC', endpoint: '192.168.1.20' }

function readyConnect() {
  return vi.spyOn(api, 'connect').mockImplementation(async () => {
    __emitMockEvent('stream-ready', {})
  })
}

function pendingRequest(overrides: Partial<ConnectionRequest> = {}): ConnectionRequest {
  return {
    id: 'req-1',
    hostDeviceId: 'dev-h',
    requesterDeviceId: 'dev-c1',
    requesterLabel: 'Home Laptop',
    state: 'pending',
    deadline: Date.now() + 30_000,
    permissions: { control: true, files: true, clipboard: true, audio: true },
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  __resetMockBackend()
  localStorage.setItem('nodedesk.preview.session', 'yes') // signed-in preview
})

describe('connection state machine', () => {
  it('SESSION-01: trusted target connects straight through to the viewer', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest({ state: 'accepted' }))
    const connect = readyConnect()
    const { result } = renderHook(() => useConnection({ approvalPollMs: 50, connectTimeoutMs: 5_000 }))

    await act(() => result.current.start(TARGET))
    expect(connect).toHaveBeenCalledWith('192.168.1.20')
    expect(result.current.state).toEqual({
      kind: 'connected',
      target: TARGET,
      requestId: 'req-1',
      interimViewer: true,
      permissions: { control: true, files: true, clipboard: true, audio: true },
      quality: 'auto',
    })
  })

  it('SESSION-03: repeated Connect during an attempt is a no-op', async () => {
    const create = vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest({ state: 'accepted' }))
    readyConnect()
    const { result } = renderHook(() => useConnection({ approvalPollMs: 50 }))

    await act(async () => {
      void result.current.start(TARGET)
      void result.current.start(TARGET)
      void result.current.start(TARGET)
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('awaitingApproval -> accepted via polling, then connects', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest())
    const status = vi
      .spyOn(api, 'getRequestStatus')
      .mockResolvedValueOnce(pendingRequest())
      .mockResolvedValue(pendingRequest({ state: 'accepted' }))
    const connect = readyConnect()
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30, connectTimeoutMs: 5_000 }))

    await act(() => result.current.start(TARGET))
    expect(result.current.state.kind).toBe('awaitingApproval')
    await act(() => new Promise((r) => setTimeout(r, 200)))
    expect(status.mock.calls.length).toBeGreaterThan(0)
    expect(connect).toHaveBeenCalled()
    expect(result.current.state.kind).toBe('connected')
  })

  it('SESSION-04: native connect failure ends in a usable failed state', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest({ state: 'accepted' }))
    vi.spyOn(api, 'connect').mockRejectedValue(new Error('moonlight missing'))
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30 }))

    await act(() => result.current.start(TARGET))
    expect(result.current.state).toEqual({ kind: 'failed', target: TARGET, message: 'moonlight missing' })
  })

  it('rejected and expired requests are terminal and distinct', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest())
    vi.spyOn(api, 'getRequestStatus').mockResolvedValue(pendingRequest({ state: 'rejected' }))
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30 }))

    await act(() => result.current.start(TARGET))
    await act(() => new Promise((r) => setTimeout(r, 120)))
    expect(result.current.state).toMatchObject({ kind: 'failed', message: 'The connection request was declined.' })
  })

  it('SESSION-05: cancel stops the attempt and ignores a late acceptance', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest())
    vi.spyOn(api, 'getRequestStatus').mockResolvedValue(pendingRequest({ state: 'accepted' }))
    const cancelReq = vi.spyOn(api, 'cancelConnectionRequest').mockResolvedValue()
    const connect = readyConnect()
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30 }))

    await act(() => result.current.start(TARGET))
    expect(result.current.state.kind).toBe('awaitingApproval')
    await act(() => result.current.cancel())
    expect(result.current.state.kind).toBe('cancelled')
    expect(cancelReq).toHaveBeenCalledWith('req-1')
    // The late accepted status must not launch anything.
    await act(() => new Promise((r) => setTimeout(r, 150)))
    expect(connect).not.toHaveBeenCalled()
  })

  it('SESSION-09: disconnect ends the viewer session and closes the grant', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest({ state: 'accepted' }))
    readyConnect()
    const disconnectNative = vi.spyOn(api, 'disconnect').mockResolvedValue()
    const end = vi.spyOn(api, 'endConnectionRequest').mockResolvedValue()
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30 }))

    await act(() => result.current.start(TARGET))
    expect(result.current.state.kind).toBe('connected')
    await act(() => result.current.disconnect())
    expect(disconnectNative).toHaveBeenCalled()
    expect(end).toHaveBeenCalledWith('req-1')
    expect(result.current.state.kind).toBe('idle')
  })

  it('SESSION-11: a viewer exit event reconciles a connected session', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest({ state: 'accepted' }))
    readyConnect()
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30 }))
    await act(() => result.current.start(TARGET))
    expect(result.current.state.kind).toBe('connected')
    // Simulate the external viewer exiting (mock disconnect emits it).
    await act(() => api.disconnect())
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(result.current.state.kind).toBe('idle')
  })

  it('SESSION-02: process start without a ready signal stays connecting, then fails', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest({ state: 'accepted' }))
    vi.spyOn(api, 'connect').mockImplementation(async () => {
      __emitMockEvent('stream-started', '192.168.1.20')
    })
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30, connectTimeoutMs: 40 }))
    await act(() => result.current.start(TARGET))
    expect(result.current.state.kind).toBe('failed')
    expect((result.current.state as { message: string }).message).toMatch(/on screen/)
  })

  it('SESSION-07/08: a drop retries on the short schedule and revocation stops it', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(pendingRequest({ state: 'accepted' }))
    const connect = vi.spyOn(api, 'connect').mockImplementation(async () => {
      __emitMockEvent('stream-ready', {})
    })
    const { result } = renderHook(() =>
      useConnection({ approvalPollMs: 20, connectTimeoutMs: 200, reconnectDelaysMs: [30, 30, 30] }),
    )
    await act(() => result.current.start(TARGET))
    expect(result.current.state.kind).toBe('connected')

    await act(async () => {
      __emitMockEvent('stream-exited', false)
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(result.current.state.kind).toBe('reconnecting')

    await act(async () => {
      __emitMockEvent('stream-revoked', true)
      await new Promise((r) => setTimeout(r, 80))
    })
    expect(result.current.state.kind).toBe('failed')
    expect((result.current.state as { message: string }).message).toMatch(/host ended/)
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
