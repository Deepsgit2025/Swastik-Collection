import { useEffect, useState } from 'react'

/**
 * How many bills are still waiting to reach WhatsApp.
 *
 * This exists because the print gate stopped blocking on 2026-08-24. Printing
 * used to be impossible until both WhatsApp copies had confirmed, which made
 * an undelivered bill impossible to miss — you simply couldn't print it. Now
 * you can, so the only thing standing between an undelivered bill and nobody
 * ever noticing is this count.
 *
 * Refreshes on the same two signals the badge uses — a status change, and the
 * push emitted after an automatic retry run — so it never polls.
 */
export function usePendingBillCount(): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      window.api
        .getPendingBillCount()
        .then((next) => {
          if (!cancelled) setCount(next)
        })
        .catch(() => {
          // A count that can't be read is not worth surfacing an error over —
          // the badge beside it already reports a session in trouble.
        })
    }

    refresh()
    const stopPending = window.api.onPendingBillsChanged(refresh)
    // A sale completing doesn't push, so a status change is also taken as a
    // reason to re-read: it is the moment the number is most likely to move.
    const stopState = window.api.onWhatsAppState(refresh)
    return () => {
      cancelled = true
      stopPending()
      stopState()
    }
  }, [])

  return count
}
