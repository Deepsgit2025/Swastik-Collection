import { Bill } from './Bill.tsx'
import type { SaleRecord } from '../types/sale.ts'
import { BILL_WIDTH_MM } from '../lib/billPrintLayout.ts'
import { mmToIn } from '../lib/labelLayout.ts'
import { useShopSettings } from '../hooks/useShopSettings.ts'

export interface BillPrintSheetProps {
  sale: SaleRecord | null
  /** Only present when the sale is linked to a party. */
  partyName?: string | null
}

/**
 * Off-screen print target for the bill (PHASE7.md section 1), reusing the
 * exact print pipeline Phase 4 built for labels rather than a second,
 * different one: `.print-sheet` (src/index.css — generalized from Phase 4's
 * label-only `.print-label-sheet` so both print targets share one
 * hide-everything-else-under-@media-print rule) stays `display: none` in
 * the normal UI and is the only thing `@media print` reveals, so
 * `window.print()` prints just this content regardless of which screen
 * called it — same trick LabelPrintSheet.tsx uses.
 *
 * Unlike LabelPrintSheet's fixed-height die-cut stock, the ShipPro is
 * printing continuous-roll receipt paper here: width is fixed
 * (`BILL_WIDTH_MM`) but height is deliberately left `auto` in the `@page`
 * rule below so the page grows to fit however many items are on the bill
 * instead of clipping or padding to a fixed page length. That rule is
 * written here as an inline `<style>` tag rather than in index.css for the
 * same reason LabelPrintSheet.tsx does it: a `<style>` element's rules
 * apply regardless of its own box's `display: none`, so it's safe to always
 * render this alongside the hidden sheet.
 *
 * This is also where the shop header is fetched (PHASE12.md section 1), so
 * `Bill` itself stays a pure presentational component and every future caller
 * — Phase 7's not-yet-built Owner reprint included — gets the header without
 * having to know where it comes from. Rendering is held back until the read
 * resolves for the same reason `sale` is checked: a bill with no shop name on
 * it must not be what reaches the printer. The read runs on mount of whichever
 * screen holds this sheet, long before a sale is completed.
 */
export function BillPrintSheet({ sale, partyName = null }: BillPrintSheetProps) {
  const shop = useShopSettings()

  if (!sale || !shop) return null

  return (
    <div className="print-sheet">
      <style>{`@media print { @page { size: ${mmToIn(BILL_WIDTH_MM)}in auto; margin: 0; } }`}</style>
      <Bill sale={sale} shop={shop} partyName={partyName} />
    </div>
  )
}
