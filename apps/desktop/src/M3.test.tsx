import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { api, __resetMockBackend } from './lib/api'

// M3: device enrollment + synchronized computer management (preview backend
// simulates the service; service-side behavior is covered by
// services/directory/test/devices.test.js with real crypto).

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
  __resetMockBackend()
})

async function renderSignedIn() {
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
  await screen.findByText('preview@example.invalid', {}, { timeout: 3000 })
}

async function enrollThisComputer() {
  await userEvent.click(screen.getByRole('button', { name: 'This Computer' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Enroll this computer' }, { timeout: 3000 }))
  // Grouped 3-3-3 public ID appears (HOST-01).
  await screen.findByText('482 913 705', {}, { timeout: 3000 })
}

describe('Enrollment (HOST-01/02)', () => {
  it('enrolls explicitly and shows a grouped Device ID', async () => {
    await renderSignedIn()
    await userEvent.click(screen.getByRole('button', { name: 'This Computer' }))
    // Not enrolled before the explicit action.
    expect(screen.queryByText('482 913 705')).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Enroll this computer' }))
    expect(await screen.findByText('482 913 705', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Device ID' })).toBeInTheDocument()
  })

  it('HOST-02: enrollment failure shows a retryable error, no fake ID', async () => {
    await renderSignedIn()
    vi.spyOn(api, 'enrollDevice').mockRejectedValue(new Error('service down'))
    await userEvent.click(screen.getByRole('button', { name: 'This Computer' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Enroll this computer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/service down/)
    expect(screen.queryByText(/[0-9]{3} [0-9]{3} [0-9]{3}/)).not.toBeInTheDocument()
  })
})

describe('Saved computers (LIST-01/04/11, DEVICE-01..08)', () => {
  it('LIST-01/11: the enrolled device syncs into My Computers and is labeled This computer', async () => {
    await renderSignedIn()
    await enrollThisComputer()
    await userEvent.click(screen.getByRole('button', { name: 'My Computers' }))
    const row = (await screen.findByText('Demo-PC', {}, { timeout: 3000 })).closest('tr')!
    expect(within(row).getByText('This computer')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    expect(within(row).getByText('482 913 705')).toBeInTheDocument()
  })

  it('LIST-04: search matches ID digits with or without grouping spaces', async () => {
    await renderSignedIn()
    await enrollThisComputer()
    await userEvent.click(screen.getByRole('button', { name: 'My Computers' }))
    await screen.findByText('Demo-PC', {}, { timeout: 3000 })

    const search = screen.getByRole('textbox', { name: 'Search computers' })
    await userEvent.type(search, '482913705')
    expect(screen.getByText('Demo-PC')).toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.type(search, '482 913 705')
    expect(screen.getByText('Demo-PC')).toBeInTheDocument()
  })

  it('DEVICE-01/02: Add explains the Device ID and validates input', async () => {
    await renderSignedIn()
    await userEvent.click(screen.getByRole('button', { name: 'Add computer' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(/shown under.*This Computer/i)
    expect(within(dialog).getByText('Device ID')).toBeInTheDocument()

    // Malformed ID: rejected with field guidance, no save attempted.
    await userEvent.type(within(dialog).getByLabelText(/Computer name/), 'Helper Target')
    await userEvent.type(within(dialog).getByLabelText(/Device ID/), '123')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add computer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/nine digits/)
  })

  it('DEVICE-03/04: unknown ID is a real lookup failure', async () => {
    await renderSignedIn()
    await userEvent.click(screen.getByRole('button', { name: 'Add computer' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText(/Computer name/), 'Office PC')
    await userEvent.type(within(dialog).getByLabelText(/Device ID/), '000 000 001')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add computer' }))
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(/No computer with that ID/)
    // No row was created.
    expect(screen.queryByText('Office PC')).not.toBeInTheDocument()
  })

  it('DEVICE-06/08: rename and remove work through the row menu with clear scope copy', async () => {
    await renderSignedIn()
    await enrollThisComputer()
    await userEvent.click(screen.getByRole('button', { name: 'My Computers' }))
    await screen.findByText('Demo-PC', {}, { timeout: 3000 })

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Demo-PC' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = screen.getByRole('dialog')
    const input = within(dialog).getByLabelText(/Computer name/)
    await userEvent.clear(input)
    await userEvent.type(input, 'Studio Box')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Studio Box', {}, { timeout: 3000 })).toBeInTheDocument()
    // Identity fields unchanged.
    expect(screen.getByText('482 913 705')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Studio Box' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
    const confirm = screen.getByRole('dialog')
    expect(confirm).toHaveTextContent(/does not uninstall|not uninstall|change who is allowed/i)
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('No computers yet', {}, { timeout: 3000 })).toBeInTheDocument()
  })
})
