import { useLayoutEffect, useRef } from 'react'
import JsBarcode from 'jsbarcode'
import { formatCurrency } from '../lib/format.ts'
import { DEFAULT_LABEL_HEIGHT_MM, DEFAULT_LABEL_WIDTH_MM, mmToIn } from '../lib/labelLayout.ts'

export interface LabelProps {
  itemName: string
  price: number | null
  barcodeValue: string
  header?: string | null
  line1?: string | null
  line2?: string | null
  line3?: string | null
  line4?: string | null
  /** Physical label size (Label Size Settings, `src/db/settings.ts`). Defaults to the original 50mm x 25mm stock. */
  widthMm?: number
  heightMm?: number
}

/**
 * The label template (PHASE4.md section 3, extended per client request to
 * add Header + up to 4 freeform lines on top of the original item
 * name/price/barcode fields — see Vyapar reference screenshot). Used as-is
 * both for the on-screen preview and inside LabelPrintSheet for actual
 * printing, so what the user previews is exactly what prints.
 *
 * The physical label defaults to 2in x 1in (50mm x 25mm, the client-confirmed
 * original stock size) but is now configurable via Label Size Settings
 * (`widthMm`/`heightMm`, `src/db/settings.ts`) — every row below is
 * deliberately tiny and single-line/truncated to fit that default. Header/
 * line1-4 are optional and only take up space when provided; a shop that
 * fills in all of them on a long item name should expect clipping
 * (`overflow-hidden` + `truncate`) rather than the tag growing past whatever
 * stock size is configured.
 *
 * useLayoutEffect (not useEffect) so the barcode SVG is populated
 * synchronously before paint — LabelPrintSheet's print flow relies on this
 * to be flushSync-safe (see BarcodeGeneratorScreen's handlePrint).
 */
export function Label({
  itemName,
  price,
  barcodeValue,
  header,
  line1,
  line2,
  line3,
  line4,
  widthMm = DEFAULT_LABEL_WIDTH_MM,
  heightMm = DEFAULT_LABEL_HEIGHT_MM,
}: LabelProps) {
  const barcodeRef = useRef<SVGSVGElement | null>(null)

  useLayoutEffect(() => {
    if (!barcodeRef.current) return
    JsBarcode(barcodeRef.current, barcodeValue, {
      format: 'CODE128',
      displayValue: true,
      width: 1,
      height: 22,
      margin: 0,
      fontSize: 7,
    })
  }, [barcodeValue])

  const extraLines = [line1, line2, line3, line4].filter((line): line is string => !!line)

  return (
    <div
      className="flex flex-col items-center justify-center gap-px overflow-hidden bg-white px-1 py-0.5 leading-none text-black"
      style={{ width: `${mmToIn(widthMm)}in`, height: `${mmToIn(heightMm)}in` }}
    >
      {header && <p className="w-full truncate text-center text-[7px]">{header}</p>}
      <p className="w-full truncate text-center text-[8px] font-semibold">{itemName}</p>
      {price != null && <p className="text-[11px] font-bold">{formatCurrency(price)}</p>}
      <svg ref={barcodeRef} className="max-w-full" />
      {extraLines.map((line, index) => (
        <p key={index} className="w-full truncate text-center text-[6px]">
          {line}
        </p>
      ))}
    </div>
  )
}
