import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type AccountProfile } from './api'

/**
 * Account state machine (SPEC §07):
 *   restoring -> signedOut | signedIn | restoreError
 *   signedOut -> signingIn -> signedIn | signedOut | authError
 *   signedIn -> signingOut -> signedOut
 * Every async response is checked against an epoch so a late callback from a
 * cancelled attempt or a previous account can never mutate current state
 * (AUTH-04, AUTH-08).
 */

export type AccountStatus =
  | { kind: 'restoring' }
  | { kind: 'signedOut' }
  | { kind: 'signingIn' }
  | { kind: 'signedIn'; profile: AccountProfile }
  | { kind: 'signingOut'; profile: AccountProfile }
  | { kind: 'restoreError'; message: string }
  | { kind: 'authError'; message: string }

export interface AccountActions {
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  retryRestore: () => Promise<void>
}

export function useAccount(): [AccountStatus, AccountActions] {
  const [status, setStatus] = useState<AccountStatus>({ kind: 'restoring' })
  const epoch = useRef(0)
  const signInInFlight = useRef(false)

  const restore = useCallback(async () => {
    const e = ++epoch.current
    setStatus({ kind: 'restoring' })
    try {
      const state = await api.getAuthState()
      if (e !== epoch.current) return
      setStatus(state.state === 'signedIn' ? { kind: 'signedIn', profile: state.profile } : { kind: 'signedOut' })
    } catch (err) {
      if (e !== epoch.current) return
      setStatus({ kind: 'restoreError', message: err instanceof Error ? err.message : 'Restore failed' })
    }
  }, [])

  useEffect(() => {
    void restore()
  }, [restore])

  const signIn = useCallback(async () => {
    // AUTH-04: at most one active attempt.
    if (signInInFlight.current) return
    signInInFlight.current = true
    const e = ++epoch.current
    setStatus({ kind: 'signingIn' })
    try {
      const result = await api.signInWithGoogle()
      if (e !== epoch.current) return // superseded (e.g. sign-out/switch raced)
      switch (result.outcome) {
        case 'signedIn':
          setStatus({ kind: 'signedIn', profile: result.profile })
          break
        case 'cancelled':
          // AUTH-03: remain signed out, no error, action stays usable.
          setStatus({ kind: 'signedOut' })
          break
        case 'notConfigured':
          setStatus({ kind: 'authError', message: result.reason })
          break
      }
    } catch (err) {
      if (e !== epoch.current) return
      setStatus({ kind: 'authError', message: err instanceof Error ? err.message : "We couldn't sign you in. Try again." })
    } finally {
      signInInFlight.current = false
    }
  }, [])

  const signOut = useCallback(async () => {
    const e = ++epoch.current
    setStatus((prev) => (prev.kind === 'signedIn' ? { kind: 'signingOut', profile: prev.profile } : prev))
    try {
      await api.signOut()
    } finally {
      // Signing out always wins locally: even if the service call failed,
      // native credential clearing is authoritative for this device and late
      // events from the old account are rejected by the epoch bump.
      if (e === epoch.current) setStatus({ kind: 'signedOut' })
    }
  }, [])

  return [status, { signIn, signOut, retryRestore: restore }]
}
