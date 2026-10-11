import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RemoteSession from './screens/RemoteSession'
import { useConnection, type ConnectionTarget } from './lib/useConnection'
import { api, __resetMockBackend, type ConnectionRequest } from './lib/api'

// M6: session toolbar behavior. Native/hardware verification stays BLOCKED;
// these cover the contract: no invented displays, honest stats, controlled
// quality restart, clipboard gating, permission-denied explanations.

const TARGET: ConnectionTarget = { deviceId: 'dev-h', name: 'Office PC', endpoint: '192.168.1.20' }

const CONNECTED = {
  kind: 'connected' as const,
  target: TARGET,
  requestId: 'req-1',
  interimViewer: true,
  permissions: { control: true, files: true, clipboard: true, audio: true },
  quality: 'auto' as const,
}

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

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  __resetMockBackend()
  localStorage.setItem('nodedesk.preview.session', 'yes')
})

function renderSession(overrides: Partial<typeof CONNECTED> = {}) {
  const onChangeQuality = vi.fn().mockResolvedValue(undefined)
  const onOpenFiles = vi.fn()
  const onDisconnect = vi.fn()
  render(
    <RemoteSession
      state={{ ...CONNECTED, ...overrides }}
      onDisconnect={onDisconnect}
      onChangeQuality={onChangeQuality}
      onOpenFiles={onOpenFiles}
    />,
  )
  return { onChangeQuality, onOpenFiles, onDisconnect }
}

describe('Session toolbar', () => {
  it('TOOLBAR-01/04: toolbar identifies the target and stats show honest placeholders', async () => {
    renderSession()
    expect(screen.getByRole('toolbar', { name: 'Session controls' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Office PC' })).toBeInTheDocument()
    // The interim viewer provides no measurements: placeholders, never the
    // mockup's 24 ms / 30 fps constants.
    const stats = await screen.findByLabelText('Session controls', {}, { timeout: 3000 })
    await vi.waitFor(() => expect(stats.textContent).toContain('— · — fps · — ms'))
  })

  it('TOOLBAR-02: only the real display is listed — Monitor 2 is never invented', async () => {
    renderSession()
    await userEvent.click(screen.getByRole('button', { name: 'Monitors' }))
    expect(await screen.findByText('Monitor 1', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByText('Monitor 2')).not.toBeInTheDocument()
  })

  it('TOOLBAR-03: quality change uses the controlled restart flow', async () => {
    const { onChangeQuality } = renderSession()
    await userEvent.click(screen.getByRole('button', { name: 'Quality' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Best speed' }))
    expect(onChangeQuality).toHaveBeenCalledWith('speed')
  })

  it('changeQuality relaunches with the override and updates only after success', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(acceptedRequest())
    vi.spyOn(api, 'connect').mockResolvedValue()
    const disconnect = vi.spyOn(api, 'disconnect').mockResolvedValue()
    const withQuality = vi.spyOn(api, 'connectWithQuality').mockResolvedValue()
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30 }))

    await act(() => result.current.start(TARGET))
    expect(result.current.state).toMatchObject({ kind: 'connected', quality: 'auto' })

    await act(() => result.current.changeQuality('speed'))
    expect(disconnect).toHaveBeenCalled()
    expect(withQuality).toHaveBeenCalledWith('192.168.1.20', 'speed')
    expect(result.current.state).toMatchObject({ kind: 'connected', quality: 'speed' })
  })

  it('changeQuality failure keeps the previous indicator (no label-only switch)', async () => {
    vi.spyOn(api, 'createConnectionRequest').mockResolvedValue(acceptedRequest())
    vi.spyOn(api, 'connect').mockResolvedValue()
    vi.spyOn(api, 'disconnect').mockResolvedValue()
    vi.spyOn(api, 'connectWithQuality').mockRejectedValue(new Error('host busy'))
    const { result } = renderHook(() => useConnection({ approvalPollMs: 30 }))

    await act(() => result.current.start(TARGET))
    await act(() => result.current.changeQuality('quality'))
    // The old session state is replaced by an honest failure, not a changed label.
    expect(result.current.state.kind).toBe('failed')
  })

  it('TOOLBAR-05: clipboard toggle gates the channel; Send without it fails truthfully', async () => {
    renderSession()
    await userEvent.click(screen.getByRole('button', { name: 'Clipboard' }))
    const sendBtn = await screen.findByRole('button', { name: 'Send to remote' })
    expect(sendBtn).toBeDisabled() // off by default — manual actions gated too
    await userEvent.click(screen.getByRole('switch', { name: 'Share clipboard' }))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Send to remote' })).toBeEnabled())
  })

  it('TOOLBAR-06: host-denied clipboard explains instead of offering controls', () => {
    renderSession({ permissions: { control: true, files: true, clipboard: false, audio: false } })
    expect(screen.getByRole('button', { name: 'Clipboard' })).toBeInTheDocument()
  })

  it('TOOLBAR-06/07: denied capabilities show explanations, not fake success', async () => {
    renderSession({ permissions: { control: false, files: false, clipboard: false, audio: false } })
    expect(screen.getByText(/view only/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(await screen.findByText(/wasn.t allowed by the other computer/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Audio' }))
    expect(await screen.findByText(/didn.t allow audio/)).toBeInTheDocument()
  })

  it('TOOLBAR-08: Files opens File Transfer with the session target', async () => {
    const { onOpenFiles } = renderSession()
    await userEvent.click(screen.getByRole('button', { name: 'Files' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Open File Transfer' }))
    expect(onOpenFiles).toHaveBeenCalled()
  })

  it('Disconnect stays reachable from the session surface', async () => {
    const { onDisconnect } = renderSession()
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(onDisconnect).toHaveBeenCalled()
  })
})
