import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ComputerCard from './ComputerCard'
import { api, type Computer } from '../lib/api'

const online: Computer = {
  id: '192.168.1.20',
  name: 'AI Workstation',
  os: 'windows',
  address: '192.168.1.20',
  via: 'lan',
  online: true,
  specs: 'RTX 3090 · 64 GB RAM',
  cpuPct: 14,
  gpuPct: 72,
  uptime: '6 d 4 h',
  hasAccessCode: true,
}

const offline: Computer = {
  id: '192.168.1.44',
  name: 'Bedroom PC',
  os: 'windows',
  address: '192.168.1.44',
  via: 'manual',
  online: false,
  specs: 'Added manually',
  mac: 'AA:BB:CC:DD:EE:02',
  hasAccessCode: false,
}

function renderCard(computer: Computer, overrides: Partial<Parameters<typeof ComputerCard>[0]> = {}) {
  const props = {
    computer,
    onOpen: vi.fn(),
    onPair: vi.fn(),
    onMessage: vi.fn(),
    ...overrides,
  }
  render(<ComputerCard {...props} />)
  return props
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ComputerCard', () => {
  it('shows an online computer with its live utilization', () => {
    renderCard(online)
    expect(screen.getByText('AI Workstation')).toBeInTheDocument()
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('14%')).toBeInTheDocument()
    expect(screen.getByText('GPU')).toBeInTheDocument()
    expect(screen.getByText('72%')).toBeInTheDocument()
  })

  it('offers CONNECT when online and WAKE when offline', () => {
    const { unmount } = render(
      <ComputerCard computer={online} onOpen={vi.fn()} onPair={vi.fn()} onMessage={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'CONNECT' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'WAKE' })).not.toBeInTheDocument()
    unmount()

    renderCard(offline)
    expect(screen.getByRole('button', { name: 'WAKE' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'CONNECT' })).not.toBeInTheDocument()
  })

  it('offers PAIR only when no access code is stored yet', () => {
    const { unmount } = render(
      <ComputerCard computer={online} onOpen={vi.fn()} onPair={vi.fn()} onMessage={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: /PAIR/ })).not.toBeInTheDocument()
    unmount()

    renderCard({ ...online, hasAccessCode: false })
    expect(screen.getByRole('button', { name: /PAIR/ })).toBeInTheDocument()
  })

  it('opens the device when the name is clicked', async () => {
    const { onOpen } = renderCard(online)
    await userEvent.click(screen.getByText('AI Workstation'))
    expect(onOpen).toHaveBeenCalledWith(online)
  })

  it('sends a wake signal and reports it', async () => {
    const wake = vi.spyOn(api, 'wake').mockResolvedValue(undefined)
    const { onMessage } = renderCard(offline)

    await userEvent.click(screen.getByRole('button', { name: 'WAKE' }))

    expect(wake).toHaveBeenCalledWith('192.168.1.44')
    await waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('Bedroom PC'))
    })
  })

  it('surfaces a wake failure as an error rather than silently succeeding', async () => {
    vi.spyOn(api, 'wake').mockRejectedValue(new Error('No MAC address known'))
    const { onMessage } = renderCard(offline)

    await userEvent.click(screen.getByRole('button', { name: 'WAKE' }))

    await waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('No MAC address known'), true)
    })
  })

  it('disables the wake button while the request is in flight', async () => {
    let release: () => void = () => {}
    vi.spyOn(api, 'wake').mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    renderCard(offline)

    await userEvent.click(screen.getByRole('button', { name: 'WAKE' }))
    const button = screen.getByRole('button', { name: 'SENDING…' })
    expect(button).toBeDisabled()

    release()
    await waitFor(() => expect(screen.getByRole('button', { name: 'WAKE' })).toBeEnabled())
  })

  it('hides utilization meters for a computer with no metrics', () => {
    renderCard(offline)
    expect(screen.queryByText('CPU')).not.toBeInTheDocument()
  })
})
