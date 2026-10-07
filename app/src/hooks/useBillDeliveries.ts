import { useCallback, useEffect, useState } from 'react'
import type { BillDeliveryRow } from '../types/whatsapp.ts'

/**
 * Every bill sent to a customer, newest first, for the Owner-only
 * bill-delivery view on the Connect WhatsApp screen. Fetches the current
 * list once on mount, then patches individual rows' ack in place as real
 * `message_ack` events arrive from the main process — no polling or
 * full-list refetch on every tick update.
 */
export function useBillDeliveries(): {
  deliveries: BillDeliveryRow[]
  loading: boolean
  resend: (saleId: number) => Promise<void>
} {
  const [deliveries, setDeliveries] = useState<BillDeliveryRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.api.getBillDeliveries().then((rows) => {
      if (!cancelled) {
        setDeliveries(rows)
        setLoading(false)
      }
    })

    const unsubscribe = window.api.onWhatsAppAck(({ waMessageId, ack }) => {
      setDeliveries((prev) => prev.map((row) => (row.waMessageId === waMessageId ? { ...row, ack } : row)))
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // The main process hands back the whole refreshed list rather than one row:
  // a retry can add rows (a new attempt per unsent recipient) as well as
  // change existing ones, so there's nothing sensible to patch in place.
  const resend = useCallback(async (saleId: number) => {
    setDeliveries(await window.api.resendBill(saleId))
  }, [])

  return { deliveries, loading, resend }
}
