import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onEvent, type ConnectionRequest, type QualityPreset, type SessionPermissions } from './api'
import { SESSION_CONSTANTS } from './sessionConstants'

/**
 * Connection state machine (SPEC §07):
 *   idle -> resolving -> authorizing -> awaitingApproval -> connecting
 *   -> connected -> reconnecting -> connected | failed
 *   any pending state -> cancelling -> cancelled
 *   connected -> disconnecting -> disconnected
 *
 * Every async step is bound to an attemptId; late events from a superseded or
 * cancelled attempt are discarded (SESSION-05, AUTH-08). Timers are
 * centralized in SESSION_CONSTANTS and injectable for tests.
 */

export interface ConnectionTarget {
  deviceId: string
  name: string
  /** Best current route hint (LAN/tailnet endpoint), if known. */
  endpoint?: string
  /** Per-session quality override (Settings default applies otherwise). */
  quality?: QualityPreset
}

export type ConnectionState =
  | { kind: 'idle' }
  | { kind: 'authorizing'; target: ConnectionTarget; attemptId: string }
  | { kind: 'awaitingApproval'; target: ConnectionTarget; attemptId: string; requestId: string }
  | { kind: 'connecting'; target: ConnectionTarget; attemptId: string; requestId: string | null }
  | {
      kind: 'connected'
      target: ConnectionTarget
      requestId: string | null
      interimViewer: boolean
      /** Host-granted capabilities for this session (TOOLBAR-05..07). */
      permissions: SessionPermissions
      /** The quality actually applied to the running session. */
      quality: QualityPreset
    }
  | { kind: 'failed'; target: ConnectionTarget; message: string }
  | { kind: 'cancelled' }
  | { kind: 'disconnecting'; target: ConnectionTarget }

export interface ConnectionOptions {
  approvalPollMs?: number
  connectTimeoutMs?: number
}

export function useConnection(options: ConnectionOptions = {}) {
  const approvalPollMs = options.approvalPollMs ?? SESSION_CONSTANTS.approvalPollMs
  const connectTimeoutMs = options.connectTimeoutMs ?? SESSION_CONSTANTS.connectTimeoutMs

  const [state, setState] = useState<ConnectionState>({ kind: 'idle' })
  const attemptRef = useRef(0)
  const inFlightRef = useRef(false) // synchronous guard (SESSION-03)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = () => {
    if (pollTimer.current) clearInterval(pollTimer.current)
    if (timeoutTimer.current) clearTimeout(timeoutTimer.current)
    pollTimer.current = null
    timeoutTimer.current = null
  }

  // Viewer exit reconciles session state (SESSION-11): the external viewer
  // closing means the interim session ended.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onEvent('stream-exited', () => {
      inFlightRef.current = false
      setState((prev) => (prev.kind === 'connected' ? { kind: 'idle' } : prev))
    }).then((fn) => (unlisten = fn))
    return () => {
      unlisten?.()
      clearTimers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fail = (target: ConnectionTarget, message: string, attemptId: string) => {
    if (String(attemptRef.current) !== attemptId) return
    clearTimers()
    inFlightRef.current = false
    setState({ kind: 'failed', target, message })
  }

  const launchViewer = useCallback(
    async (target: ConnectionTarget, request: { id: string; permissions: SessionPermissions } | null, attemptId: string) => {
      const requestId = request?.id ?? null
      const permissions: SessionPermissions = request?.permissions ?? {
        control: true,
        files: true,
        clipboard: true,
        audio: true,
      }
      const quality: QualityPreset = target.quality ?? 'auto'
      setState({ kind: 'connecting', target, attemptId, requestId })
      timeoutTimer.current = setTimeout(
        () => fail(target, "We couldn't reach " + target.name + '.', attemptId),
        connectTimeoutMs,
      )
      try {
        // The native layer launches the real viewer over a verified route.
        // 'stream-started' means the viewer process is up — the interim
        // external-viewer session is labeled as such (SESSION-02 spike).
        // NETWORK-03: without a verified route there is no fake Connected —
        // the failure names the actual remedies.
        if (!target.endpoint) {
          fail(
            target,
            `We couldn't reach ${target.name} from this network. Put both computers on the same network, or set up Tailscale on both — the directory entry alone can't route traffic.`,
            attemptId,
          )
          return
        }
        const address = target.endpoint
        if (quality === 'auto') {
          await api.connect(address)
        } else {
          await api.connectWithQuality(address, quality)
        }
        if (String(attemptRef.current) !== attemptId) return
        clearTimers()
        setState({ kind: 'connected', target, requestId, interimViewer: true, permissions, quality })
      } catch (e) {
        fail(target, e instanceof Error ? e.message : "We couldn't reach " + target.name + '.', attemptId)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectTimeoutMs],
  )

  const start = useCallback(
    async (target: ConnectionTarget) => {
      // SESSION-03: one attempt at a time; repeated clicks are no-ops. The
      // guard is a synchronous ref — React state is stale between fast clicks.
      if (inFlightRef.current) return
      inFlightRef.current = true
      const attemptId = String(++attemptRef.current)
      clearTimers()
      setState({ kind: 'authorizing', target, attemptId })

      let request: ConnectionRequest | null = null
      try {
        request = await api.createConnectionRequest(target.deviceId, target.name)
      } catch (e) {
        fail(target, e instanceof Error ? e.message : "We couldn't reach " + target.name + '.', attemptId)
        return
      }
      if (String(attemptRef.current) !== attemptId) return // superseded/cancelled

      if (request.state === 'accepted') {
        // Trusted + unattended: straight to connecting (J2).
        void launchViewer(target, request, attemptId)
        return
      }

      // Attended: poll until the host decides or the deadline passes.
      setState({ kind: 'awaitingApproval', target, attemptId, requestId: request.id })
      const requestId = request.id
      pollTimer.current = setInterval(async () => {
        if (String(attemptRef.current) !== attemptId) return
        try {
          const status = await api.getRequestStatus(requestId)
          if (String(attemptRef.current) !== attemptId) return
          if (status.state === 'accepted') {
            clearTimers()
            void launchViewer(target, status, attemptId)
          } else if (status.state === 'rejected') {
            fail(target, 'The connection request was declined.', attemptId)
          } else if (status.state === 'expired') {
            fail(target, 'The request expired.', attemptId)
          } else if (status.state === 'cancelled') {
            setState({ kind: 'cancelled' })
          }
        } catch {
          /* transient poll failure: keep waiting until the deadline */
        }
      }, approvalPollMs)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.kind, approvalPollMs, launchViewer],
  )

  const cancel = useCallback(async () => {
    attemptRef.current++ // reject late events from the cancelled attempt
    inFlightRef.current = false
    clearTimers()
    const current = state
    setState({ kind: 'cancelled' })
    // SESSION-05: native/backend cancellation runs; pending approvals die.
    if (current.kind === 'awaitingApproval' || current.kind === 'connecting') {
      if (current.requestId) await api.cancelConnectionRequest(current.requestId).catch(() => {})
    }
  }, [state])

  const disconnect = useCallback(async () => {
    const current = state
    if (current.kind !== 'connected') return
    attemptRef.current++
    clearTimers()
    setState({ kind: 'disconnecting', target: current.target })
    // SESSION-09: the actual viewer session ends and the grant is closed.
    await api.disconnect().catch(() => {})
    if (current.requestId) await api.endConnectionRequest(current.requestId).catch(() => {})
    inFlightRef.current = false
    setState({ kind: 'idle' })
  }, [state])

  /** TOOLBAR-03: the interim external viewer cannot switch quality live, so
   * changing quality is a controlled restart: the viewer closes, relaunches
   * with the new policy, and the visible quality changes only after the
   * relaunch actually succeeds. The grant (request) stays open. */
  const changeQuality = useCallback(
    async (quality: QualityPreset) => {
      const current = state
      if (current.kind !== 'connected' || current.quality === quality) return
      const attemptId = String(++attemptRef.current)
      clearTimers()
      await api.disconnect().catch(() => {})
      const target: ConnectionTarget = { ...current.target, quality }
      setState({ kind: 'connecting', target, attemptId, requestId: current.requestId })
      await launchViewer(
        target,
        current.requestId ? { id: current.requestId, permissions: current.permissions } : null,
        attemptId,
      )
    },
    [state, launchViewer],
  )

  const dismiss = useCallback(() => {
    attemptRef.current++
    inFlightRef.current = false
    clearTimers()
    setState({ kind: 'idle' })
  }, [])

  return { state, start, cancel, disconnect, dismiss, changeQuality }
}
