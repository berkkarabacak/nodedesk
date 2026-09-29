import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import AccountPanel from './AccountPanel'
import type { AccountStatus } from '../lib/api'

const signedOut: AccountStatus = {
  configured: true,
  registryConfigured: true,
  signedIn: false,
  linked: false,
}

function renderPanel(status: AccountStatus, overrides: Partial<Parameters<typeof AccountPanel>[0]> = {}) {
  const props = {
    status,
    busy: false,
    error: '',
    onSignIn: vi.fn(),
    onSignOut: vi.fn(),
    onLink: vi.fn(),
    ...overrides,
  }
  render(<AccountPanel {...props} />)
  return props
}

describe('AccountPanel', () => {
  it('offers Google sign-in when nobody is signed in', async () => {
    const { onSignIn } = renderPanel(signedOut)
    const button = screen.getByRole('button', { name: 'Sign in with Google' })
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(onSignIn).toHaveBeenCalledOnce()
  })

  it('explains that sign-in is not set up yet', () => {
    renderPanel({ ...signedOut, configured: false })
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled()
    expect(screen.getByText("Sign-in isn't set up on this computer yet.")).toBeInTheDocument()
  })

  it('shows the signed-in email and link state', async () => {
    const { onSignOut, onLink } = renderPanel({
      configured: true,
      registryConfigured: true,
      signedIn: true,
      email: 'owner@example.com',
      linked: false,
    })
    expect(screen.getByText('Signed in as owner@example.com')).toBeInTheDocument()
    expect(screen.getByText('This computer is not linked')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Link this computer' }))
    expect(onLink).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalledOnce()
  })

  it('says when this computer is linked', () => {
    renderPanel({
      configured: true,
      registryConfigured: true,
      signedIn: true,
      email: 'owner@example.com',
      linked: true,
    })
    expect(screen.getByText('This computer is linked')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Link this computer' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })
})
