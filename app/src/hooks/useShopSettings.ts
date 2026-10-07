import { useEffect, useState } from 'react'
import type { ShopSettings } from '../types/settings.ts'

/**
 * The shop's name, address and phone for anything the renderer draws with a
 * shop header on it — today that is the printed bill (`BillPrintSheet`).
 *
 * Returns `null` until the read resolves, deliberately: `BillPrintSheet`
 * renders nothing while this is null, so a bill can never reach the printer
 * with a blank header. The read happens on mount of whatever screen holds the
 * sheet, which is many seconds before any sale is completed and printed.
 *
 * Read once, not subscribed: these values change only when the Owner saves
 * them on the Settings screen, and a save re-reads there. A bill printed in the
 * same session as an edit picks the new values up on the next navigation, which
 * is the same freshness the WhatsApp side gets (`send.ts` re-reads per sale).
 */
export function useShopSettings(): ShopSettings | null {
  const [shop, setShop] = useState<ShopSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .getShopSettings()
      .then((next) => {
        if (!cancelled) setShop(next)
      })
      .catch(() => {
        // Left null, which keeps the print sheet unmounted rather than
        // printing a bill with no shop on it. The Settings screen is where a
        // real read failure would be worth surfacing.
      })
    return () => {
      cancelled = true
    }
  }, [])

  return shop
}
