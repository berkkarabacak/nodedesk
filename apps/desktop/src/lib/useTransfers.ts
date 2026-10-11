import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onEvent, type ConflictPolicy, type TransferItem } from './api'

/**
 * M7 transfer queue model (SPEC §07):
 *   queued -> transferring -> verifying -> completed
 *   transferring -> interrupted -> (retry) -> transferring
 *   any non-terminal -> cancelled; failures -> failed
 * Correlation is strictly by transferId (FILE-04). The target account/address
 * is bound at enqueue time — switching the picker never retargets queued work
 * (FILE-10). Events from cancelled transfers cannot reopen their rows.
 */
export function useTransfers() {
  const [items, setItems] = useState<TransferItem[]>([])
  const cancelledRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Subscribe before any enqueue can emit (SPEC §07 ordering rule).
    let unlisten: (() => void) | undefined
    void api
      .listTransfers()
      .then((existing) => {
        setItems(existing)
        for (const t of existing) if (t.state === 'cancelled') cancelledRef.current.add(t.transferId)
      })
      .catch(() => {})
    void onEvent('transfer-progress', (p: TransferItem) => {
      setItems((prev) => {
        const i = prev.findIndex((t) => t.transferId === p.transferId)
        if (cancelledRef.current.has(p.transferId) && p.state !== 'cancelled') {
          return prev // FILE-05: late events cannot report Done after cancel
        }
        if (i === -1) return [...prev, p]
        const next = [...prev]
        next[i] = p
        return next
      })
    }).then((fn) => (unlisten = fn))
    return () => unlisten?.()
  }, [])

  const enqueueSend = useCallback(async (address: string, paths: string[], onConflict?: ConflictPolicy) => {
    // Folders are rejected before enqueue until recursive support exists
    // (FILE-08) — the UI never claims a folder was sent.
    const folders = paths.filter((p) => p.endsWith('/') || p.endsWith('\\'))
    if (folders.length > 0) {
      throw new Error("Folder transfer isn't supported yet — compress the folder or send the files inside.")
    }
    const ids = await api.sendFiles(address, paths, onConflict)
    // Queued rows appear immediately, keyed by their real transfer IDs.
    setItems((prev) => [
      ...prev,
      ...ids.map((transferId, i) => ({
        transferId,
        direction: 'up' as const,
        file: paths[i].split(/[\\/]/).pop() ?? 'file',
        address,
        doneBytes: 0,
        totalBytes: 0,
        state: 'queued' as const,
      })),
    ])
    return ids
  }, [])

  const enqueueReceive = useCallback(async (address: string, path: string, onConflict?: ConflictPolicy) => {
    const transferId = await api.downloadFile(address, path, onConflict)
    setItems((prev) => [
      ...prev,
      {
        transferId,
        direction: 'down' as const,
        file: path.split(/[\\/]/).pop() ?? 'file',
        address,
        doneBytes: 0,
        totalBytes: 0,
        state: 'queued' as const,
      },
    ])
    return transferId
  }, [])

  const cancel = useCallback(async (id: string) => {
    cancelledRef.current.add(id)
    setItems((prev) => prev.map((t) => (t.transferId === id && t.state !== 'completed' ? { ...t, state: 'cancelled' } : t)))
    await api.cancelTransfer(id).catch(() => {})
  }, [])

  const retry = useCallback(async (id: string) => {
    cancelledRef.current.delete(id)
    setItems((prev) => prev.map((t) => (t.transferId === id ? { ...t, state: 'queued' } : t)))
    await api.retryTransfer(id)
  }, [])

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((t) => !['completed', 'cancelled', 'failed'].includes(t.state)))
  }, [])

  return { items, enqueueSend, enqueueReceive, cancel, retry, clearFinished }
}
