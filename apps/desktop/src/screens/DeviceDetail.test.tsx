import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api, type Computer } from '../lib/api'
import DeviceDetail from './DeviceDetail'

const computer: Computer = {
  id: '192.168.1.20',
  name: 'AI Workstation',
  os: 'windows',
  address: '192.168.1.20',
  via: 'lan',
  online: true,
  specs: 'RTX 3090 · 64 GB RAM',
  hasAccessCode: true,
}

describe('DeviceDetail forget', () => {
  it('confirms inside the app instead of a browser dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const forget = vi.spyOn(api, 'forgetHost').mockResolvedValue(undefined)
    const onBack = vi.fn()

    render(<DeviceDetail computer={computer} onBack={onBack} />)
    await userEvent.click(screen.getByTitle('Forget this computer'))

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
    expect(screen.getByText(/Forget AI Workstation/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(forget).not.toHaveBeenCalled()
    expect(screen.queryByText(/Forget AI Workstation/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByTitle('Forget this computer'))
    await userEvent.click(screen.getByRole('button', { name: /^Forget$/ }))

    await waitFor(() => expect(forget).toHaveBeenCalledWith('192.168.1.20'))
    expect(onBack).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})
