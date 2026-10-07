import { Label } from './Label.tsx'
import type { BarcodeLabelRow } from '../types/barcodeLabel.ts'
import type { LabelSize } from '../types/settings.ts'
import { DEFAULT_LABEL_HEIGHT_MM, DEFAULT_LABEL_WIDTH_MM, mmToIn } from '../lib/labelLayout.ts'

export interface QueuedLabelPrintItem {
  label: BarcodeLabelRow
  copies: number
}

export interface LabelPrintSheetProps {
  items: QueuedLabelPrintItem[]
  /** Current Label Size Settings value; defaults to the original 50mm x 25mm stock. */
  labelSize?: LabelSize
}

/**
 * Off-screen print target for the label (PHASE4.md section 4). Invisible in
 * the normal UI (`.print-sheet` is `display: none` — see index.css, shared
 * with BillPrintSheet.tsx per PHASE7.md section 1); only `@media print`
 * reveals it and hides everything else, so `window.print()` prints just
 * this content regardless of what screen it's called from. `items` is the
 * whole generated batch (PHASE4.md section 2,
 * extended to a Vyapar-style queue per client request) — each item's `copies`
 * repeats its Label, one per page (`page-break-after: always` in index.css),
 * in queue order, all in a single print job.
 *
 * `labelSize` (Label Size Settings, `src/db/settings.ts`) drives both the
 * Label components' rendered size and the `@page` rule the print driver
 * reads for physical page size — the latter can't come from index.css since
 * CSS can't read this JS/DB-backed value, so it's written here as an inline
 * `<style>` instead. That style tag is inert outside `@media print` and
 * unaffected by `.print-sheet`'s `display: none` (a `<style>` element's
 * rules always apply regardless of its own box's visibility), so it's safe
 * to always render alongside the hidden sheet.
 */
export function LabelPrintSheet({ items, labelSize }: LabelPrintSheetProps) {
  if (items.length === 0) return null

  const widthMm = labelSize?.widthMm ?? DEFAULT_LABEL_WIDTH_MM
  const heightMm = labelSize?.heightMm ?? DEFAULT_LABEL_HEIGHT_MM

  return (
    <div className="print-sheet">
      <style>{`@media print { @page { size: ${mmToIn(widthMm)}in ${mmToIn(heightMm)}in; margin: 0; } }`}</style>
      {items.flatMap(({ label, copies }) =>
        Array.from({ length: copies }, (_, index) => (
          <div className="print-label" key={`${label.id}-${index}`}>
            <Label
              itemName={label.item_name}
              price={label.price}
              barcodeValue={label.barcode_value}
              header={label.header}
              line1={label.line1}
              line2={label.line2}
              line3={label.line3}
              line4={label.line4}
              widthMm={widthMm}
              heightMm={heightMm}
            />
          </div>
        )),
      )}
    </div>
  )
}
