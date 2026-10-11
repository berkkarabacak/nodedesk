import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import IncomingConnection from './screens/IncomingConnection'
import App from './App'
import { api, __resetMockBackend, type ConnectionRequest } from './lib/api'

// M4 component tests: incoming approval UI + trust management. Service-side
// enforcement is covered by services/directory/test/approval.test.js.

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
  __resetMockBackend()
})

function makeRequest(overrides: Partial<ConnectionRequest> = {}): ConnectionRequest {
  return {
    id: 'req-1',
    hostDeviceId: 'host-device',
    requesterDeviceId: 'helper-device',
    requesterLabel: "Daniel's MacBook Pro",
    requesterEmail: 'daniel@example.com',
    requesterName: 'Daniel Reyes',
    isNewDevice: true,
    sameAccount: false,
    state: 'pending',
    deadline: Date.now() + 30_000,
    permissions: { control: false, files: false, clipboard: false, audio: false },
    ...overrides,
  }
}

describe('Incoming Connection (APPROVAL-01/02/03)', () => {
  it('shows verified requester identity, New device, and time remaining', () => {
    render(<IncomingConnection request={makeRequest()} onDecided={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Incoming connection' })).toBeInTheDocument()
    expect(screen.getByText('Daniel Reyes')).toBeInTheDocument()
    expect(screen.getByText('daniel@example.com')).toBeInTheDocument()
    expect(screen.getByText('New device')).toBeInTheDocument()
    expect(screen.getByText(/Request expires in/)).toHaveTextContent(/\d+s/)
    expect(screen.getByText('View your screen')).toBeInTheDocument()
    expect(screen.getByText(/Always on/)).toBeInTheDocument()
    // Audio starts off per the proposed default.
    expect(screen.getByRole('switch', { name: 'Play audio' })).toHaveAttribute('aria-checked', 'false')
  })

  it('Accept grants exactly the selected permissions', async () => {
    const accept = vi.spyOn(api, 'acceptIncomingRequest').mockResolvedValue(makeRequest({ state: 'accepted' }))
    const onDecided = vi.fn()
    render(<IncomingConnection request={makeRequest()} onDecided={onDecided} />)

    await userEvent.click(screen.getByRole('switch', { name: 'Control keyboard and mouse' }))
    await userEvent.click(screen.getByRole('switch', { name: 'Transfer files' }))
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))

    expect(accept).toHaveBeenCalledWith('req-1', { control: true, files: true, clipboard: false, audio: false }, false)
    expect(onDecided).toHaveBeenCalledWith('accepted')
  })

  it('Reject grants nothing', async () => {
    const reject = vi.spyOn(api, 'rejectIncomingRequest').mockResolvedValue()
    const accept = vi.spyOn(api, 'acceptIncomingRequest')
    const onDecided = vi.fn()
    render(<IncomingConnection request={makeRequest()} onDecided={onDecided} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(reject).toHaveBeenCalledWith('req-1')
    expect(accept).not.toHaveBeenCalled()
    expect(onDecided).toHaveBeenCalledWith('rejected')
  })

  it('expires on the host deadline without pausing', async () => {
    const onDecided = vi.fn()
    render(<IncomingConnection request={makeRequest({ deadline: Date.now() + 1200 })} onDecided={onDecided} />)
    await screen.findByText(/0s/, {}, { timeout: 5000 })
    await vi.waitFor(() => expect(onDecided).toHaveBeenCalledWith('expired'))
  })

  it('a late Accept after the request is gone reports honestly', async () => {
    vi.spyOn(api, 'acceptIncomingRequest').mockRejectedValue(new Error('request_not_pending'))
    render(<IncomingConnection request={makeRequest()} onDecided={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer pending/)
  })

  it('offers persistent trust only for the owner account (APPROVAL-10)', () => {
    const { unmount } = render(<IncomingConnection request={makeRequest({ sameAccount: false })} onDecided={() => {}} />)
    expect(screen.queryByRole('switch', { name: /Trust this device/ })).not.toBeInTheDocument()
    unmount()
    render(<IncomingConnection request={makeRequest({ sameAccount: true })} onDecided={() => {}} />)
    expect(screen.getByRole('switch', { name: /Trust this device/ })).toBeInTheDocument()
  })
})

describe('Trusted computers in Settings (TRUST-01/02/03)', () => {
  async function renderSignedInSettings(trusted: { controllerDeviceId: string; label: string; trustedAt: number }[]) {
    vi.spyOn(api, 'listTrustedControllers').mockResolvedValue(trusted)
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    await screen.findByText('preview@example.invalid', {}, { timeout: 3000 })
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
  }

  it('lists real trusted controllers and revokes one with confirmation', async () => {
    const revoke = vi.spyOn(api, 'revokeTrustedController').mockResolvedValue()
    await renderSignedInSettings([
      { controllerDeviceId: 'dev-c1', label: 'Home Laptop', trustedAt: Date.now() - 86_400_000 },
      { controllerDeviceId: 'dev-c3', label: 'Studio Workstation', trustedAt: Date.now() },
    ])
    expect(await screen.findByText('Home Laptop', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText('Studio Workstation')).toBeInTheDocument()

    const row = screen.getByText('Home Laptop').closest('li')!
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(/no longer connect without approval/)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    expect(revoke).toHaveBeenCalledWith('dev-c1')
    await screen.findByText('Studio Workstation')
    expect(screen.queryByText('Home Laptop')).not.toBeInTheDocument()
  })

  it('TRUST-03: revocation failure is not false success', async () => {
    vi.spyOn(api, 'revokeTrustedController').mockRejectedValue(new Error('host unreachable'))
    await renderSignedInSettings([{ controllerDeviceId: 'dev-c1', label: 'Home Laptop', trustedAt: Date.now() }])
    const row = (await screen.findByText('Home Laptop', {}, { timeout: 3000 })).closest('li')!
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/host unreachable/)
    // Entry remains — we did not promise access ended.
    expect(screen.getByText('Home Laptop')).toBeInTheDocument()
  })

  it('empty trust list is honest', async () => {
    await renderSignedInSettings([])
    expect(await screen.findByText(/No trusted computers yet/, {}, { timeout: 3000 })).toBeInTheDocument()
  })
})
