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
 * `connecting` stays connecting until `stream-ready`. Process spawn
 * (`stream-started`) is not Connected (SESSION-02). A drop after readiness
 * retries on the 1/2/4 s schedule unless the host revokes the grant
 * (SESSION-07/08). Every async step is bound to an attemptId.
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
  | {
      kind: 'reconnecting'
      target: ConnectionTarget
      attemptId: string
      requestId: string | null
      attempt: number
      permissions: SessionPermissions
      quality: QualityPreset
    }
  | { kind: 'failed'; target: ConnectionTarget; message: string }
  | { kind: 'cancelled' }
  | { kind: 'disconnecting'; target: ConnectionTarget }

export interface ConnectionOptions {
  approvalPollMs?: number
  connectTimeoutMs?: number
  reconnectDelaysMs?: readonly number[]
}

function waitForReady(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let unlisten: (() => void) | undefined
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unlisten?.()
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    // onEvent registers the mock listener synchronously before its first await.
    void onEvent('stream-ready', () => finish(true)).then((fn) => {
      unlisten = fn
      if (settled) fn()
    })
  })
}

export function useConnection(options: ConnectionOptions = {}) {
  const approvalPollMs = options.approvalPollMs ?? SESSION_CONSTANTS.approvalPollMs
  const connectTimeoutMs = options.connectTimeoutMs ?? SESSION_CONSTANTS.connectTimeoutMs
  const reconnectDelays = options.reconnectDelaysMs ?? SESSION_CONSTANTS.reconnectDelaysMs
  const delaysRef = useRef(reconnectDelays)
  delaysRef.current = reconnectDelays

  const [state, setState] = useState<ConnectionState>({ kind: 'idle' })
  const attemptRef = useRef(0)
  const inFlightRef = useRef(false)
  const ignoreExit = useRef(false)
  const revokedRef = useRef(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const clearTimers = () => {
    if (pollTimer.current) clearInterval(pollTimer.current)
    if (timeoutTimer.current) clearTimeout(timeoutTimer.current)
    pollTimer.current = null
    timeoutTimer.current = null
  }

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
      if (!target.endpoint) {
        fail(
          target,
          `We couldn't reach ${target.name} from this network. Put both computers on the same network, or set up Tailscale on both — the directory entry alone can't route traffic.`,
          attemptId,
        )
        return
      }
      const address = target.endpoint
      // Bookkeeping for later file and terminal calls. It must not delay the
      // viewer: the host enforces the grant when those calls arrive.
      if (requestId) void api.registerSessionGrant(address, requestId).catch(() => {})
      const readyPromise = waitForReady(connectTimeoutMs)
      try {
        if (quality === 'auto') {
          await api.connect(address)
        } else {
          await api.connectWithQuality(address, quality)
        }
      } catch (e) {
        fail(target, e instanceof Error ? e.message : "We couldn't reach " + target.name + '.', attemptId)
        return
      }
      if (String(attemptRef.current) !== attemptId) return
      // SESSION-02: the command returning only means the process spawned.
      const ready = await readyPromise
      if (String(attemptRef.current) !== attemptId || revokedRef.current) return
      if (!ready) {
        fail(target, `We couldn't confirm ${target.name} is on screen.`, attemptId)
        return
      }
      clearTimers()
      inFlightRef.current = true
      setState({ kind: 'connected', target, requestId, interimViewer: true, permissions, quality })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectTimeoutMs],
  )

  const launchRef = useRef(launchViewer)
  launchRef.current = launchViewer

  // Viewer exit, readiness, and the native reconnect schedule.
  useEffect(() => {
    const unlistens: Array<() => void> = []
    const track = (p: Promise<() => void>) => {
      void p.then((fn) => unlistens.push(fn))
    }

    const scheduleUiReconnect = (prev: Extract<ConnectionState, { kind: 'connected' }>, index: number) => {
      const delay = delaysRef.current[index]
      const attemptId = String(attemptRef.current)
      if (delay === undefined) {
        inFlightRef.current = false
        setState({
          kind: 'failed',
          target: prev.target,
          message: 'The connection dropped and did not recover.',
        })
        return
      }
      setState({
        kind: 'reconnecting',
        target: prev.target,
        attemptId,
        requestId: prev.requestId,
        attempt: index + 1,
        permissions: prev.permissions,
        quality: prev.quality,
      })
      window.setTimeout(() => {
        if (revokedRef.current || ignoreExit.current) return
        if (String(attemptRef.current) !== attemptId) return
        const endpoint = prev.target.endpoint
        if (!endpoint) {
          setState({ kind: 'failed', target: prev.target, message: `We couldn't reach ${prev.target.name}.` })
          return
        }
        void (async () => {
          const readyPromise = waitForReady(connectTimeoutMs)
          try {
            if (prev.quality === 'auto') await api.connect(endpoint)
            else await api.connectWithQuality(endpoint, prev.quality)
          } catch {
            scheduleUiReconnect(prev, index + 1)
            return
          }
          const ready = await readyPromise
          if (revokedRef.current || String(attemptRef.current) !== attemptId) return
          if (!ready) {
            scheduleUiReconnect(prev, index + 1)
            return
          }
          setState({
            kind: 'connected',
            target: prev.target,
            requestId: prev.requestId,
            interimViewer: true,
            permissions: prev.permissions,
            quality: prev.quality,
          })
        })()
      }, delay)
    }

    track(
      onEvent('stream-exited', (success) => {
        if (ignoreExit.current) return
        const prev = stateRef.current
        // Preview path: a failed exit after Connected uses the same 1/2/4 s
        // schedule the native watcher uses. A clean exit is the viewer closing.
        if (prev.kind === 'connected' && success === false) {
          scheduleUiReconnect(prev, 0)
          return
        }
        if (prev.kind === 'connecting') {
          fail(prev.target, `We couldn't confirm ${prev.target.name} is on screen.`, prev.attemptId)
          return
        }
        if (prev.kind === 'connected' || prev.kind === 'reconnecting') {
          inFlightRef.current = false
          setState({ kind: 'idle' })
        }
      }),
    )
    track(
      onEvent('stream-reconnecting', (payload) => {
        if (ignoreExit.current || revokedRef.current) return
        const prev = stateRef.current
        if (prev.kind !== 'connected' && prev.kind !== 'reconnecting' && prev.kind !== 'connecting') return
        const attempt = typeof payload === 'object' && payload && 'attempt' in payload ? Number(payload.attempt) : 1
        setState({
          kind: 'reconnecting',
          target: prev.target,
          attemptId: 'attemptId' in prev ? prev.attemptId : String(attemptRef.current),
          requestId: 'requestId' in prev ? prev.requestId : null,
          attempt,
          permissions: 'permissions' in prev ? prev.permissions : { control: true, files: true, clipboard: true, audio: true },
          quality: 'quality' in prev ? prev.quality : 'auto',
        })
      }),
    )
    track(
      onEvent('stream-ready', () => {
        // The initial launch waits on this event itself and keeps the granted
        // permissions. This handler covers a native reconnect, where the UI is
        // already in `reconnecting` and must not call connect() again.
        const prev = stateRef.current
        if (prev.kind !== 'reconnecting' || revokedRef.current) return
        setState({
          kind: 'connected',
          target: prev.target,
          requestId: prev.requestId,
          interimViewer: true,
          permissions: prev.permissions,
          quality: prev.quality,
        })
      }),
    )
    track(
      onEvent('stream-reconnect-failed', () => {
        const prev = stateRef.current
        if (prev.kind !== 'connected' && prev.kind !== 'reconnecting' && prev.kind !== 'connecting') return
        inFlightRef.current = false
        setState({
          kind: 'failed',
          target: prev.target,
          message: prev.kind === 'connecting'
            ? `We couldn't confirm ${prev.target.name} is on screen.`
            : 'The connection dropped and did not recover.',
        })
      }),
    )
    track(
      onEvent('stream-revoked', () => {
        revokedRef.current = true
        const prev = stateRef.current
        if (prev.kind !== 'connected' && prev.kind !== 'reconnecting' && prev.kind !== 'connecting') return
        inFlightRef.current = false
        setState({ kind: 'failed', target: prev.target, message: 'The host ended this session.' })
      }),
    )

    return () => {
      unlistens.forEach((fn) => fn())
      clearTimers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectTimeoutMs])

  // SESSION-08: while retrying, an ended grant stops the next attempt.
  useEffect(() => {
    if (state.kind !== 'reconnecting' || !state.requestId) return
    const requestId = state.requestId
    const target = state.target
    let cancelled = false
    const timer = setInterval(() => {
      void api
        .getRequestStatus(requestId)
        .then((status) => {
          if (cancelled || status.state === 'accepted' || status.state === 'pending') return
          revokedRef.current = true
          void api.markSessionRevoked().catch(() => {})
          inFlightRef.current = false
          setState({ kind: 'failed', target, message: 'The host ended this session.' })
        })
        .catch(() => {})
    }, Math.min(approvalPollMs, 500))
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [state, approvalPollMs])

  const start = useCallback(
    async (target: ConnectionTarget) => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      revokedRef.current = false
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
      if (String(attemptRef.current) !== attemptId) return

      if (request.state === 'accepted') {
        await launchRef.current(target, request, attemptId)
        return
      }

      setState({ kind: 'awaitingApproval', target, attemptId, requestId: request.id })
      const requestId = request.id
      pollTimer.current = setInterval(() => {
        void (async () => {
          if (String(attemptRef.current) !== attemptId) return
          try {
            const status = await api.getRequestStatus(requestId)
            if (String(attemptRef.current) !== attemptId) return
            if (status.state === 'accepted') {
              clearTimers()
              void launchRef.current(target, status, attemptId)
            } else if (status.state === 'rejected') {
              fail(target, 'The connection request was declined.', attemptId)
            } else if (status.state === 'expired') {
              fail(target, 'The request expired.', attemptId)
            } else if (status.state === 'cancelled') {
              inFlightRef.current = false
              setState({ kind: 'cancelled' })
            }
          } catch {
            /* transient poll failure: keep waiting until the deadline */
          }
        })()
      }, approvalPollMs)
    },
    [approvalPollMs],
  )

  const cancel = useCallback(async () => {
    attemptRef.current++
    inFlightRef.current = false
    clearTimers()
    const current = stateRef.current
    setState({ kind: 'cancelled' })
    const endpoint = 'target' in current ? current.target.endpoint : undefined
    if (endpoint) await api.clearSessionGrant(endpoint).catch(() => {})
    if (
      (current.kind === 'awaitingApproval' || current.kind === 'connecting' || current.kind === 'reconnecting') &&
      current.requestId
    ) {
      await api.cancelConnectionRequest(current.requestId).catch(() => {})
    }
  }, [])

  const disconnect = useCallback(async () => {
    const current = stateRef.current
    if (current.kind !== 'connected' && current.kind !== 'reconnecting') return
    attemptRef.current++
    ignoreExit.current = true
    clearTimers()
    setState({ kind: 'disconnecting', target: current.target })
    await api.disconnect().catch(() => {})
    if (current.requestId) await api.endConnectionRequest(current.requestId).catch(() => {})
    if (current.target.endpoint) await api.clearSessionGrant(current.target.endpoint).catch(() => {})
    inFlightRef.current = false
    ignoreExit.current = false
    setState({ kind: 'idle' })
  }, [])

  const changeQuality = useCallback(async (quality: QualityPreset) => {
    const current = stateRef.current
    if (current.kind !== 'connected' || current.quality === quality) return
    const attemptId = String(++attemptRef.current)
    ignoreExit.current = true
    clearTimers()
    await api.disconnect().catch(() => {})
    ignoreExit.current = false
    const target: ConnectionTarget = { ...current.target, quality }
    await launchRef.current(
      target,
      current.requestId ? { id: current.requestId, permissions: current.permissions } : null,
      attemptId,
    )
  }, [])

  const dismiss = useCallback(() => {
    attemptRef.current++
    inFlightRef.current = false
    revokedRef.current = false
    clearTimers()
    setState({ kind: 'idle' })
  }, [])

  return { state, start, cancel, disconnect, dismiss, changeQuality }
}
