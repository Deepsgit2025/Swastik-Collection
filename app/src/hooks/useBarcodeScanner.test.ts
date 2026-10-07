import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, renderHook } from '@testing-library/react'
import { useBarcodeScanner } from './useBarcodeScanner.ts'

/**
 * These tests simulate keystroke timing by controlling `performance.now()`
 * directly rather than using real delays or fake timers — deterministic and
 * fast. They exercise the hook's fast-burst-vs-human-typing logic only; they
 * do not touch real Helett HT410 hardware. See PHASE4.md section 8 criterion
 * 4, which still needs a real-hardware pass before Phase 4 is marked done.
 */

let currentTime = 0

function dispatchKey(key: string, advanceMs: number, opts: Partial<KeyboardEventInit> = {}) {
  currentTime += advanceMs
  fireEvent.keyDown(window, { key, ...opts })
}

/** Fires each character of `code` as its own keydown, `gapMs` apart, then a terminator. */
function simulateBurst(code: string, gapMs: number, terminator: 'Enter' | 'Tab' = 'Enter') {
  dispatchKey(code[0], 0)
  for (const ch of code.slice(1)) {
    dispatchKey(ch, gapMs)
  }
  dispatchKey(terminator, gapMs)
}

beforeEach(() => {
  currentTime = 0
  vi.spyOn(performance, 'now').mockImplementation(() => currentTime)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBarcodeScanner', () => {
  it('treats a fast keystroke burst terminated by Enter as a scan', () => {
    const onScan = vi.fn()
    renderHook(() => useBarcodeScanner(onScan))

    simulateBurst('8901234567890', 10, 'Enter')

    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith('8901234567890')
  })

  it('also accepts Tab as the terminator (HT410 suffix can be configured to send Tab)', () => {
    const onScan = vi.fn()
    renderHook(() => useBarcodeScanner(onScan))

    simulateBurst('CODE128ABC', 8, 'Tab')

    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith('CODE128ABC')
  })

  it('does NOT treat normal-speed human typing as a scan', () => {
    const onScan = vi.fn()
    renderHook(() => useBarcodeScanner(onScan))

    // ~150ms between keystrokes is a plausible human typing cadence, well
    // above the default 50ms scanner threshold.
    simulateBurst('hello', 150, 'Enter')

    expect(onScan).not.toHaveBeenCalled()
  })

  it('does NOT treat a slightly-fast human burst above the threshold as a scan', () => {
    const onScan = vi.fn()
    renderHook(() => useBarcodeScanner(onScan))

    simulateBurst('abcdef', 60, 'Enter')

    expect(onScan).not.toHaveBeenCalled()
  })

  it('ignores a bare Enter press with no preceding fast burst', () => {
    const onScan = vi.fn()
    renderHook(() => useBarcodeScanner(onScan))

    dispatchKey('Enter', 0)

    expect(onScan).not.toHaveBeenCalled()
  })

  it('ignores a fast burst shorter than minLength (stray keys before Enter)', () => {
    const onScan = vi.fn()
    renderHook(() => useBarcodeScanner(onScan, { minLength: 4 }))

    simulateBurst('ab', 10, 'Enter')

    expect(onScan).not.toHaveBeenCalled()
  })

  it('resets the buffer on a modifier-key combo, so it does not leak into the next burst', () => {
    const onScan = vi.fn()
    renderHook(() => useBarcodeScanner(onScan))

    dispatchKey('a', 0)
    dispatchKey('b', 10)
    dispatchKey('c', 10, { ctrlKey: true })
    dispatchKey('Enter', 10)

    expect(onScan).not.toHaveBeenCalled()
  })

  it('starts a new burst after a slow keystroke breaks the previous one', () => {
    const onScan = vi.fn()
    renderHook(() => useBarcodeScanner(onScan))

    dispatchKey('x', 0)
    dispatchKey('y', 300) // slow gap breaks the burst
    dispatchKey('1', 10)
    dispatchKey('2', 10)
    dispatchKey('3', 10)
    dispatchKey('4', 10)
    dispatchKey('Enter', 10)

    // only the fast tail ("y1234") should count, and only if it clears minLength
    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith('y1234')
  })

  it('does nothing while disabled', () => {
    const onScan = vi.fn()
    renderHook(() => useBarcodeScanner(onScan, { enabled: false }))

    simulateBurst('8901234567890', 10, 'Enter')

    expect(onScan).not.toHaveBeenCalled()
  })

  it('respects onScan changing across renders without re-registering a stale closure', () => {
    const onScanFirst = vi.fn()
    const onScanSecond = vi.fn()
    const { rerender } = renderHook(({ cb }) => useBarcodeScanner(cb), {
      initialProps: { cb: onScanFirst },
    })

    rerender({ cb: onScanSecond })
    simulateBurst('8901234567890', 10, 'Enter')

    expect(onScanFirst).not.toHaveBeenCalled()
    expect(onScanSecond).toHaveBeenCalledWith('8901234567890')
  })
})
