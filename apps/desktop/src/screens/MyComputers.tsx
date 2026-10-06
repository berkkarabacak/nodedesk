import { useEffect, useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Plus, Search } from 'lucide-react'
import { api, formatPublicId, type Computer, type Settings } from '../lib/api'
import { Button, Dialog, Notice } from '../components/ui'

type ListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; computers: Computer[] }
  | { kind: 'empty' }
  | { kind: 'loadError'; stale?: Computer[] }

/** Directory rows carry the public ID in `address` (set in refresh). */
function isPublicId(address: string) {
  return /^[0-9]{9}$/.test(address)
}

/**
 * Screen 02 — My Computers. Signed in: the account-scoped directory (real
 * service; account isolation is enforced server-side). Local mode: LAN
 * discovery + manual hosts from the native core. The two sources are never
 * mixed (AUTH-08, COMPAT-01).
 */
export default function MyComputers({
  settings,
  signedIn,
  onOpenDevice,
  onConnectDirectory,
}: {
  settings: Settings
  signedIn: boolean
  onOpenDevice: (c: Computer) => void
  /** Signed-in mode: start a real connection to a saved computer (M5). */
  onConnectDirectory: (c: Computer) => void
}) {
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addAddress, setAddAddress] = useState('')
  const [addCode, setAddCode] = useState('')
  const [addDeviceId, setAddDeviceId] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<Computer | null>(null)
  const [removeTarget, setRemoveTarget] = useState<Computer | null>(null)
  const attemptRef = useRef(0)

  const refresh = async () => {
    const attempt = ++attemptRef.current
    try {
      let computers: Computer[]
      if (signedIn) {
        // Account directory: stable device identity, public ID, presence.
        const saved = await api.listDirectoryComputers()
        computers = saved.map((s) => ({
          id: s.deviceId,
          name: s.name,
          os: '',
          address: s.publicId,
          via: 'manual' as const,
          online: s.online === true,
          specs: s.isThisDevice ? 'This computer' : 'Saved computer',
          hasAccessCode: false,
          endpoint: s.endpoints?.[0],
        }))
      } else {
        computers = await api.listComputers()
      }
      if (attempt !== attemptRef.current) return // ignore stale responses
      setList(computers.length === 0 ? { kind: 'empty' } : { kind: 'loaded', computers })
    } catch {
      if (attempt !== attemptRef.current) return
      setList((prev) => ({
        kind: 'loadError',
        stale: prev.kind === 'loaded' ? prev.computers : undefined,
      }))
    }
  }

  useEffect(() => {
    setList({ kind: 'loading' })
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])

  const computers = list.kind === 'loaded' ? list.computers : (list.kind === 'loadError' ? list.stale : undefined) ?? []

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s/g, '')
    if (!q) return computers
    return computers.filter(
      (c) =>
        c.name.toLowerCase().includes(query.trim().toLowerCase()) ||
        c.address.replace(/\s/g, '').toLowerCase().includes(q),
    )
  }, [computers, query])

  const addHost = async () => {
    if (addBusy) return
    setAddError(null)
    setAddBusy(true)
    try {
      if (signedIn) {
        // DEVICE-02: validate and normalize without losing leading zeroes.
        const id = addDeviceId.replace(/\s/g, '')
        if (!addName.trim()) {
          setAddError('Enter a name for this computer.')
          return
        }
        if (!/^[0-9]{9}$/.test(id)) {
          setAddError('A Device ID is nine digits, shown under This Computer on the other machine — for example 482 913 705.')
          return
        }
        await api.resolveDeviceId(id) // DEVICE-03: real lookup before saving
        await api.addSavedComputer(id, addName.trim())
      } else {
        if (!addAddress.trim()) {
          setAddError('Enter the address shown on the other computer.')
          return
        }
        await api.addManualHost(addAddress.trim(), addCode.replace(/\s/g, ''))
      }
      setShowAdd(false)
      setAddName('')
      setAddAddress('')
      setAddCode('')
      setAddDeviceId('')
      void refresh()
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "We couldn't add that computer.")
    } finally {
      setAddBusy(false)
    }
  }

  const renameHost = async (c: Computer, name: string) => {
    // DEVICE-06/07: the account alias updates on the service; the dialog
    // keeps a correctable error and the old name stays on failure.
    await api.renameSavedComputer(c.id, name.trim())
    setRenameTarget(null)
    void refresh()
  }

  const removeHost = async (c: Computer) => {
    // DEVICE-08/10: account-wide removal with tombstone; failure keeps the row.
    await api.removeSavedComputer(c.id)
    setRemoveTarget(null)
    void refresh()
  }

  const connectDirectory = (c: Computer) => onConnectDirectory(c)

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">My Computers</h1>
          <p className="mt-1 text-sm text-nd-dim" aria-live="polite">
            {list.kind === 'loaded' && `${filtered.length} of ${computers.length} computers`}
            {list.kind === 'empty' && 'No saved computers'}
            {list.kind === 'loading' && 'Loading…'}
            {list.kind === 'loadError' && 'Connection problem'}
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <span className="flex items-center gap-2">
            <Plus className="h-4 w-4" aria-hidden /> Add computer
          </span>
        </Button>
      </div>

      <div className="mt-6 flex items-center gap-2 border-2 border-nd-divider bg-nd-surface px-3">
        <Search className="h-4 w-4 text-nd-dim" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or ID"
          aria-label="Search computers"
          className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-nd-dim"
        />
      </div>

      {list.kind === 'loading' && (
        <div className="mt-6 space-y-2" aria-label="Loading computers">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse border border-nd-rule bg-nd-surface" />
          ))}
        </div>
      )}

      {list.kind === 'loadError' && (
        <div className="mt-6">
          <Notice tone="error">
            We couldn&apos;t load your computers.{' '}
            <button onClick={() => void refresh()} className="font-bold underline">
              Retry
            </button>
          </Notice>
          {list.stale && <p className="mt-2 text-xs text-nd-dim">Showing the last known list — it may be out of date.</p>}
        </div>
      )}

      {list.kind === 'empty' && (
        <div className="mt-6 border-2 border-dashed border-nd-divider p-8 text-center">
          <p className="text-sm font-semibold">No computers yet</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-nd-dim">
            {signedIn
              ? 'Install NodeDesk on another computer, sign in with the same account, and enable remote access there — it will appear here automatically.'
              : 'Install NodeDesk on another computer and add it here. On your own network you can add it with its address and access code — saved computers that sync everywhere arrive with account sign-in.'}
          </p>
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" onClick={() => setShowAdd(true)}>
              Add computer
            </Button>
          </div>
        </div>
      )}

      {computers.length > 0 && (
        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-nd-divider text-left text-xs uppercase tracking-wider text-nd-dim">
              <th scope="col" className="py-2 pr-4 font-semibold">Computer</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Status</th>
              <th scope="col" className="py-2 pr-4 font-semibold">{signedIn ? 'Device ID' : 'Address'}</th>
              <th scope="col" className="py-2 font-semibold"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} className="border-b border-nd-rule">
                <td className="max-w-56 truncate py-3 pr-4 font-semibold" title={c.name}>
                  {c.name}
                  {c.specs === 'This computer' && (
                    <span className="ml-2 border border-nd-divider px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-nd-dim">
                      This computer
                    </span>
                  )}
                </td>
                <td className="py-3 pr-4">
                  {c.online ? (
                    <span className="flex items-center gap-2 text-nd-ok">
                      <span aria-hidden className="h-2 w-2 bg-nd-ok" /> Online
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 text-nd-dim">
                      <span aria-hidden className="h-2 w-2 bg-nd-dim" /> Offline
                    </span>
                  )}
                </td>
                <td className="py-3 pr-4 font-mono text-xs text-nd-dim">
                  {isPublicId(c.address) ? formatPublicId(c.address) : c.address}
                </td>
                <td className="py-3 text-right">
                  <span className="flex items-center justify-end gap-2">
                    {c.specs !== 'This computer' &&
                      (c.online ? (
                        <Button onClick={() => (signedIn ? connectDirectory(c) : onOpenDevice(c))}>Connect</Button>
                      ) : (
                        <span className="text-xs text-nd-dim">This computer is offline.</span>
                      ))}
                    {signedIn && (
                      <span className="relative">
                        <button
                          aria-label={`Actions for ${c.name}`}
                          aria-expanded={menuFor === c.id}
                          onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                          className="border-2 border-nd-divider p-2 text-nd-dim hover:bg-nd-surface hover:text-nd-text"
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </button>
                        {menuFor === c.id && (
                          <div role="menu" className="absolute right-0 z-10 mt-1 w-36 border-2 border-nd-divider bg-nd-bg shadow-[var(--nd-shadow)]">
                            <button
                              role="menuitem"
                              className="block w-full px-4 py-2 text-left text-sm hover:bg-nd-surface"
                              onClick={() => {
                                setMenuFor(null)
                                setRenameTarget(c)
                              }}
                            >
                              Rename
                            </button>
                            <button
                              role="menuitem"
                              className="block w-full px-4 py-2 text-left text-sm text-nd-danger hover:bg-nd-surface"
                              onClick={() => {
                                setMenuFor(null)
                                setRemoveTarget(c)
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="py-8 text-center text-sm text-nd-dim">
                  No computers match your search.{' '}
                  <button onClick={() => setQuery('')} className="font-semibold text-nd-accent-strong underline">
                    Clear search
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {settings.mode !== 'controller' && (
        <p className="mt-8 text-xs text-nd-dim">
          Hosting on this computer is managed under This Computer.
        </p>
      )}

      {showAdd && (
        <Dialog title="Add computer" onClose={() => setShowAdd(false)}>
          {signedIn ? (
            // DEVICE-01: the dialog explains the actual identifier.
            <p className="mt-2 text-sm text-nd-dim">
              Enter the Device ID shown under <strong>This Computer</strong> on the other machine.
            </p>
          ) : (
            <p className="mt-2 text-sm text-nd-dim">
              On your own network, enter the address and access code shown in the other computer&apos;s NodeDesk
              Settings. Adding by public Device ID arrives with account sign-in.
            </p>
          )}
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void addHost()
            }}
          >
            <label className="block text-sm">
              <span className="font-semibold">Computer name</span>
              <input
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Office PC"
                required={signedIn}
                className="mt-1 w-full border-2 border-nd-divider bg-nd-surface px-3 py-2 outline-none"
              />
            </label>
            {signedIn ? (
              <label className="block text-sm">
                <span className="font-semibold">Device ID</span>
                <input
                  value={addDeviceId}
                  onChange={(e) => setAddDeviceId(e.target.value)}
                  placeholder="482 913 705"
                  inputMode="numeric"
                  required
                  className="mt-1 w-full border-2 border-nd-divider bg-nd-surface px-3 py-2 font-mono outline-none"
                />
              </label>
            ) : (
              <>
                <label className="block text-sm">
                  <span className="font-semibold">Address</span>
                  <input
                    value={addAddress}
                    onChange={(e) => setAddAddress(e.target.value)}
                    placeholder="192.168.1.50"
                    required
                    className="mt-1 w-full border-2 border-nd-divider bg-nd-surface px-3 py-2 font-mono outline-none"
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-semibold">Access code</span>
                  <input
                    value={addCode}
                    onChange={(e) => setAddCode(e.target.value)}
                    placeholder="XXXX-XXXX"
                    className="mt-1 w-full border-2 border-nd-divider bg-nd-surface px-3 py-2 font-mono outline-none"
                  />
                </label>
              </>
            )}
            {addError && <Notice tone="error">{addError}</Notice>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={addBusy}>
                {addBusy ? 'Adding…' : 'Add computer'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {renameTarget && (
        <Dialog title={`Rename ${renameTarget.name}`} onClose={() => setRenameTarget(null)}>
          <RenameForm
            initial={renameTarget.name}
            onCancel={() => setRenameTarget(null)}
            onSave={async (name) => {
              try {
                await renameHost(renameTarget, name)
              } catch (e) {
                throw e // keep the dialog open with the error
              }
            }}
          />
        </Dialog>
      )}

      {removeTarget && (
        <Dialog title={`Remove ${removeTarget.name}?`} onClose={() => setRemoveTarget(null)}>
          <RemoveForm
            name={removeTarget.name}
            onCancel={() => setRemoveTarget(null)}
            onConfirm={async () => {
              await removeHost(removeTarget)
            }}
          />
        </Dialog>
      )}
    </div>
  )
}

function RenameForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: string
  onCancel: () => void
  onSave: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!name.trim()) {
      setError('Enter a name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave(name)
    } catch (e) {
      // DEVICE-07: the previously persisted name is kept; the error stays.
      setError(e instanceof Error ? e.message : "We couldn't rename it. Try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="mt-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label className="block text-sm">
        <span className="font-semibold">Computer name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="mt-1 w-full border-2 border-nd-divider bg-nd-surface px-3 py-2 outline-none"
        />
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}

function RemoveForm({
  name,
  onCancel,
  onConfirm,
}: {
  name: string
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (e) {
      // DEVICE-10: removal failure keeps the entry with a retryable error.
      setError(e instanceof Error ? e.message : "We couldn't remove it. Try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <p className="mt-2 text-sm text-nd-dim">
        {name} will disappear from My Computers on all your devices. This does not uninstall NodeDesk or change
        who is allowed to connect to that computer.
      </p>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => void confirm()} disabled={busy}>
          {busy ? 'Removing…' : 'Remove'}
        </Button>
      </div>
    </>
  )
}
