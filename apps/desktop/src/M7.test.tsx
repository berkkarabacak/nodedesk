import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTransfers } from './lib/useTransfers'
import { api, __resetMockBackend } from './lib/api'

// M7: transfer queue contract tests (FILE-01/03/04/05/06/10). Byte-level
// integrity on real machines stays BLOCKED; the native engine's safepath and
// offset semantics keep their existing Rust tests (cargo BLOCKED here).

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  __resetMockBackend()
  localStorage.setItem('nodedesk.preview.session', 'yes')
})

describe('transfer queue (FILE-01..11)', () => {
  it('FILE-01/03: enqueue binds the target and progress comes from acknowledged bytes', async () => {
    const { result } = renderHook(() => useTransfers())
    await act(() => result.current.enqueueSend('host-a', ['C:\\docs\\report.pdf']))
    await act(() => new Promise((r) => setTimeout(r, 1400)))
    const t = result.current.items.find((x) => x.file === 'report.pdf')!
    expect(t.address).toBe('host-a')
    expect(t.state).toBe('completed')
    expect(t.doneBytes).toBe(t.totalBytes) // Done = all bytes acknowledged
  })

  it('FILE-04: same-name files from different folders stay distinct rows', async () => {
    const { result } = renderHook(() => useTransfers())
    await act(() => result.current.enqueueSend('host-a', ['C:\\a\\report.pdf', 'D:\\b\\report.pdf', 'C:\\empty.bin']))
    await act(() => new Promise((r) => setTimeout(r, 1500)))
    const rows = result.current.items.filter((x) => x.file === 'report.pdf')
    expect(rows).toHaveLength(2) // unique transfer IDs, never merged
    expect(rows[0].transferId).not.toBe(rows[1].transferId)
    // Zero-byte file completes without a division error.
    const empty = result.current.items.find((x) => x.file === 'empty.bin')!
    expect(empty.state).toBe('completed')
  })

  it('FILE-05: cancelling one item never cancels another, and late events stay cancelled', async () => {
    const { result } = renderHook(() => useTransfers())
    let ids: string[] = []
    await act(async () => {
      ids = await result.current.enqueueSend('host-a', ['C:\\f1.bin', 'C:\\f2.bin'])
    })
    expect(result.current.items).toHaveLength(2)
    await act(async () => {
      await result.current.cancel(ids[0])
    })
    expect(result.current.items.find((t) => t.transferId === ids[0])!.state).toBe('cancelled')
    // F2 proceeds to completion while F1's late events cannot reopen it.
    await act(() => new Promise((r) => setTimeout(r, 2000)))
    expect(result.current.items.find((t) => t.transferId === ids[0])!.state).toBe('cancelled')
    expect(result.current.items.find((t) => t.transferId === ids[1])!.state).toBe('completed')
  })

  it('FILE-06: only an interrupted transfer can be retried', async () => {
    const { result } = renderHook(() => useTransfers())
    await act(() => result.current.enqueueSend('host-a', ['C:\\f1.bin']))
    await act(() => new Promise((r) => setTimeout(r, 1400)))
    const id = result.current.items[0].transferId
    await expect(act(() => result.current.retry(id))).rejects.toThrow(/interrupted/)
  })

  it('FILE-10: queued work keeps its original target when the picker changes', async () => {
    const { result } = renderHook(() => useTransfers())
    await act(() => result.current.enqueueSend('host-a', ['C:\\f1.bin']))
    // A later send to a different target must not absorb the first item.
    await act(() => result.current.enqueueSend('host-b', ['C:\\f2.bin']))
    await act(() => new Promise((r) => setTimeout(r, 1400)))
    const f1 = result.current.items.find((t) => t.file === 'f1.bin')!
    const f2 = result.current.items.find((t) => t.file === 'f2.bin')!
    expect(f1.address).toBe('host-a')
    expect(f2.address).toBe('host-b')
  })

  it('FILE-08: folder drops are rejected truthfully before enqueue', async () => {
    const { result } = renderHook(() => useTransfers())
    await expect(act(() => result.current.enqueueSend('host-a', ['C:\\Documents\\']))).rejects.toThrow(
      /Folder transfer isn't supported yet/,
    )
    expect(result.current.items).toHaveLength(0) // no fake queued row
  })

  it('conflict policy is passed through to the native engine (FILE-07)', async () => {
    const send = vi.spyOn(api, 'sendFiles')
    const { result } = renderHook(() => useTransfers())
    await act(() => result.current.enqueueSend('host-a', ['C:\\f1.bin'], 'overwrite'))
    expect(send).toHaveBeenCalledWith('host-a', ['C:\\f1.bin'], 'overwrite')
  })
})
