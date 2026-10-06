import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { api, __resetMockBackend, type Settings } from './lib/api'

// App-level tests for the M1 shell: login entry (AUTH-01), navigation,
// theme across surfaces (SETTINGS-02), list failure handling (LIST-03).

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
  __resetMockBackend()
})

async function renderAppInLocalMode() {
  localStorage.setItem('nodedesk.onboarded', 'yes')
  render(<App />)
  // Wait for the shell's primary navigation.
  await screen.findByRole('navigation', { name: 'Primary' }, { timeout: 3000 })
}

describe('Login (AUTH-01)', () => {
  it('shows the real login entry point on first launch', async () => {
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    expect(screen.getByText(/Sign in once/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Stay signed in' })).toBeInTheDocument()
    // No other account's computers or fake profile.
    expect(screen.queryByText('My Computers')).not.toBeInTheDocument()
  })

  it('offers local network mode leading to onboarding', async () => {
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /Use without an account/i }))
    // Legacy local-mode onboarding remains reachable.
    expect(await screen.findByText(/host|controller/i, {}, { timeout: 3000 })).toBeInTheDocument()
  })
})

describe('Account lifecycle (AUTH-02..05, preview-simulated)', () => {
  it('sign-in enters the account shell and shows the empty directory (LIST-02)', async () => {
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    // Shell with the verified (preview) account identity.
    expect(await screen.findByText('preview@example.invalid', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText(/Preview — simulated data/)).toBeInTheDocument()
    // Real empty account directory: actionable, no fixture rows, no error.
    expect(await screen.findByText('No computers yet', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText(/appear here automatically/)).toBeInTheDocument()
    expect(screen.queryByText('AI Workstation')).not.toBeInTheDocument()
  })

  it('AUTH-03: cancelling sign-in stays signed out with no error', async () => {
    vi.spyOn(api, 'signInWithGoogle').mockResolvedValue({ outcome: 'cancelled' })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('preview@example.invalid')).not.toBeInTheDocument()
  })

  it('AUTH-04: repeated clicks start at most one attempt', async () => {
    let resolveSignIn: ((v: { outcome: 'cancelled' }) => void) | undefined
    const spy = vi.spyOn(api, 'signInWithGoogle').mockImplementation(
      () => new Promise((r) => (resolveSignIn = r)),
    )
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    await userEvent.click(await screen.findByRole('button', { name: /Complete sign-in in your browser/ }))
    expect(spy).toHaveBeenCalledTimes(1)
    resolveSignIn?.({ outcome: 'cancelled' })
  })

  it('AUTH-04: a late callback from a superseded attempt cannot sign in', async () => {
    let resolveFirst: ((v: never) => void) | undefined
    vi.spyOn(api, 'signInWithGoogle')
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({ outcome: 'cancelled' })
    render(<App />)
    // First attempt starts and hangs.
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    // Switch to local mode, then back to login and start a second attempt:
    // the first attempt's epoch is now stale.
    await userEvent.click(await screen.findByRole('button', { name: /Use without an account/i }))
    await screen.findByRole('navigation', { name: 'Primary' }, { timeout: 3000 })
    resolveFirst?.({ outcome: 'signedIn', profile: { accountId: 'x', email: 'late@evil.example', name: 'Late' } } as never)
    // The late result must not surface anywhere.
    await waitFor(() => expect(screen.queryByText('late@evil.example')).not.toBeInTheDocument())
  })

  it('AUTH-05: Stay signed in off keeps no durable session across relaunch', async () => {
    const { unmount } = render(<App />)
    // Turn stay-signed-in off BEFORE signing in.
    await userEvent.click(await screen.findByRole('switch', { name: 'Stay signed in' }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    await screen.findByText('preview@example.invalid', {}, { timeout: 3000 })
    unmount()

    render(<App />)
    // A fresh launch requires sign-in again.
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
  })

  it('AUTH-05: Stay signed in on restores the session across relaunch', async () => {
    const { unmount } = render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    await screen.findByText('preview@example.invalid', {}, { timeout: 3000 })
    unmount()

    render(<App />)
    expect(await screen.findByText('preview@example.invalid', {}, { timeout: 3000 })).toBeInTheDocument()
  })

  it('AUTH-08/09: sign-out returns to Login and clears the account context', async () => {
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    await screen.findByText('preview@example.invalid', {}, { timeout: 3000 })

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    // Back to Login; no profile, no directory access.
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
    expect(screen.queryByText('preview@example.invalid')).not.toBeInTheDocument()
  })
})

describe('SECURITY-04: secrets stay out of ordinary output', () => {
  it('settings persisted through the UI never contain token fields', async () => {
    const saveSpy = vi.spyOn(api, 'saveSettings')
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    await screen.findByText('preview@example.invalid', {}, { timeout: 3000 })
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await userEvent.click(await screen.findByRole('radio', { name: 'Dark' }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalled())
    for (const call of saveSpy.mock.calls) {
      const json = JSON.stringify(call[0]).toLowerCase()
      expect(json).not.toMatch(/token|secret|refresh|bearer|password/)
    }
  })
})

describe('App shell navigation', () => {
  it('navigates between the four sidebar screens', async () => {
    await renderAppInLocalMode()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav).toContainElement(screen.getByRole('button', { name: 'My Computers' }))

    await userEvent.click(screen.getByRole('button', { name: 'This Computer' }))
    expect(await screen.findByRole('heading', { name: 'This Computer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'This Computer' })).toHaveAttribute('aria-current', 'page')

    await userEvent.click(screen.getByRole('button', { name: 'File Transfer' }))
    expect(await screen.findByRole('heading', { name: 'File Transfer' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'My Computers' }))
    expect(await screen.findByRole('heading', { name: 'My Computers' })).toBeInTheDocument()
  })

  it('labels the browser preview as simulated', async () => {
    await renderAppInLocalMode()
    expect(screen.getByText(/Preview — simulated data/)).toBeInTheDocument()
  })
})

describe('Theme (SETTINGS-02)', () => {
  it('switches every app-owned surface to dark tokens and persists', async () => {
    const saveSpy = vi.spyOn(api, 'saveSettings')
    await renderAppInLocalMode()
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings' })

    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')

    // Theme token is applied app-wide: navigate and confirm it survives.
    await userEvent.click(screen.getByRole('button', { name: 'My Computers' }))
    expect(document.documentElement.dataset.theme).toBe('dark')

    // Persisted through the real settings save.
    await waitFor(() => expect(saveSpy).toHaveBeenCalled())
    expect(saveSpy.mock.calls.map((c) => c[0]).find((s: Settings) => s.theme === 'dark')).toBeTruthy()
  })

  it('restores a saved dark theme on launch', async () => {
    localStorage.setItem('nodedesk.onboarded', 'yes')
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      mode: 'both', startOnBoot: true, clipboardSync: true, tailscaleEnabled: true,
      codec: 'auto', bitrateMbps: 40, fps: 60, resolution: 'auto', hdr: false, theme: 'dark',
    })
    render(<App />)
    await screen.findByRole('navigation', { name: 'Primary' }, { timeout: 3000 })
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('My Computers list states (LIST-03/04/05)', () => {
  it('shows an understandable error with Retry when loading fails', async () => {
    localStorage.setItem('nodedesk.onboarded', 'yes')
    const spy = vi.spyOn(api, 'listComputers').mockRejectedValue(new Error('boom'))
    render(<App />)
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
      /couldn.?t load your computers/i,
    )
    spy.mockRestore()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    // Recovers when the real call succeeds again.
    expect(await screen.findByText('AI Workstation', {}, { timeout: 3000 })).toBeInTheDocument()
  })

  it('search filters by name and reports no matches distinctly', async () => {
    await renderAppInLocalMode()
    await screen.findByText('AI Workstation', {}, { timeout: 3000 })
    await userEvent.type(screen.getByRole('textbox', { name: 'Search computers' }), 'workstation')
    expect(screen.getByText('AI Workstation')).toBeInTheDocument()
    expect(screen.queryByText('Old Laptop')).not.toBeInTheDocument()

    await userEvent.clear(screen.getByRole('textbox', { name: 'Search computers' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Search computers' }), 'zzz-no-match')
    expect(screen.getByText(/No computers match your search/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByText('Old Laptop')).toBeInTheDocument()
  })

  it('offline computers explain instead of offering Connect', async () => {
    await renderAppInLocalMode()
    const row = (await screen.findByText('Bedroom PC', {}, { timeout: 3000 })).closest('tr')!
    expect(row).toHaveTextContent('Offline')
    expect(row).not.toHaveTextContent('Connect')
  })
})
