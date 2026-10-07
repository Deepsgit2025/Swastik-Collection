import { useEffect, useRef } from 'react'

export interface UseBarcodeScannerOptions {
  /** Max ms between keystrokes to still count as one scanner burst (real human typing is much slower). Default 50. */
  maxInterKeystrokeDelayMs?: number
  /** Minimum accumulated length to accept as a real scan, guarding against a stray Enter/Tab press. Default 4. */
  minLength?: number
  /** Set false to stop listening without unmounting the component that owns the hook. Default true. */
  enabled?: boolean
}

/**
 * Detects a barcode scanner (e.g. the Helett HT410 in keyboard-wedge mode)
 * acting as a fast keyboard: it "types" a code's characters in rapid
 * succession and terminates with Enter or Tab. Human typing has much larger
 * gaps between keystrokes, which is the signal used to tell the two apart —
 * see PHASE4.md section 5.
 *
 * Listens globally (capture phase) rather than on a specific input, since a
 * keyboard-wedge scanner sends keystrokes to whatever element currently has
 * focus (or none at all), not to a dedicated element this hook controls.
 */
export function useBarcodeScanner(onScan: (code: string) => void, options?: UseBarcodeScannerOptions): void {
  const { maxInterKeystrokeDelayMs = 50, minLength = 4, enabled = true } = options ?? {}

  const onScanRef = useRef(onScan)
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  const bufferRef = useRef('')
  const lastKeystrokeAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return

    function reset() {
      bufferRef.current = ''
      lastKeystrokeAtRef.current = null
    }

    function handleKeyDown(event: KeyboardEvent) {
      // A real scanner sends plain character keys plus a bare Enter/Tab —
      // never a modifier combo. Treat one as a break in the burst.
      if (event.ctrlKey || event.altKey || event.metaKey) {
        reset()
        return
      }

      const now = performance.now()
      const gap = lastKeystrokeAtRef.current === null ? null : now - lastKeystrokeAtRef.current

      if (event.key === 'Enter' || event.key === 'Tab') {
        const code = bufferRef.current
        const wasFastBurst = gap !== null && gap <= maxInterKeystrokeDelayMs
        reset()

        if (wasFastBurst && code.length >= minLength) {
          event.preventDefault()
          onScanRef.current(code)
        }
        return
      }

      // Only accumulate single printable characters; ignore Shift/ArrowLeft/etc.
      if (event.key.length !== 1) {
        return
      }

      if (gap === null || gap > maxInterKeystrokeDelayMs) {
        // First keystroke, or the previous one was too slow to be part of a
        // scan burst — start a fresh buffer from this character.
        bufferRef.current = event.key
      } else {
        bufferRef.current += event.key
      }
      lastKeystrokeAtRef.current = now
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      reset()
    }
  }, [enabled, maxInterKeystrokeDelayMs, minLength])
}
