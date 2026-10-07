import { formatCurrency, formatDate } from '../lib/format.ts'
import type { ShopSettings } from '../types/settings.ts'
import type { SaleRecord } from '../types/sale.ts'

export interface BillProps {
  sale: SaleRecord
  /**
   * The shop header, from the `settings` table (PHASE12.md section 1). Passed
   * in rather than read here so this stays a pure presentational component —
   * `BillPrintSheet` is what fetches it, via `useShopSettings`.
   */
  shop: ShopSettings
  /** Only present when the sale is linked to a party — shown per PHASE7.md section 1, especially important for credit sales. */
  partyName?: string | null
}

const PAYMENT_MODE_LABEL: Record<SaleRecord['payment_mode'], string> = {
  cash: 'Cash',
  upi: 'UPI',
  credit: 'Credit',
  split: 'Split',
}

/**
 * The bill layout template (PHASE7.md section 1). Used as-is both for an
 * eventual on-screen preview and inside BillPrintSheet for actual printing,
 * so what's previewed is exactly what prints — the same discipline Phase
 * 4's Label.tsx follows for labels.
 *
 * No per-line-item discount column: `sale_items` has no `discount` field —
 * discount is a single bill-level amount (see the CLAUDE.md business rule
 * and `sales.total_discount`), shown once below in the totals block
 * instead. Each item row is name-on-its-own-line plus a
 * "qty x rate ..... amount" line beneath, rather than a fixed-width table —
 * item names can run long, and this stays legible on the ShipPro's narrow
 * roll width without truncating (unlike Label.tsx's single-line
 * truncation, which fits because a label's whole footprint is tiny).
 */
export function Bill({ sale, shop, partyName = null }: BillProps) {
  return (
    <div className="flex w-full flex-col gap-1 bg-white px-2 py-2 text-[10px] leading-tight text-black">
      {/*
        Shop header, from Settings (PHASE12.md section 1) — the same `settings`
        rows the WhatsApp bill image reads, so the printed bill and the one the
        customer receives can't disagree. The address line is skipped while it's
        blank: it's optional, and an empty centred line would just be a gap.
      */}
      <div className="flex flex-col items-center gap-0.5 text-center">
        <p className="text-[13px] font-bold">{shop.shopName}</p>
        {shop.shopAddress && <p className="text-[9px]">{shop.shopAddress}</p>}
        <p className="text-[9px]">Ph: {shop.shopPhone}</p>
      </div>

      <div className="my-1 border-t border-dashed border-black" />

      <div className="flex justify-between text-[9px]">
        <span>Bill #{sale.id}</span>
        <span>{formatDate(sale.created_at)}</span>
      </div>
      {partyName && <p className="text-[9px]">Customer: {partyName}</p>}

      <div className="my-1 border-t border-dashed border-black" />

      <div className="flex flex-col gap-1">
        {sale.items.map((item) => (
          <div key={item.id} className="flex flex-col">
            <p className="font-semibold">{item.item_name}</p>
            <div className="flex justify-between text-[9px]">
              <span>
                {item.quantity} x {formatCurrency(item.unit_price)}
              </span>
              <span className="font-semibold">{formatCurrency(item.line_total)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="my-1 border-t border-dashed border-black" />

      <div className="flex flex-col gap-0.5 text-[9px]">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatCurrency(sale.subtotal)}</span>
        </div>
        <div className="flex justify-between">
          <span>Discount</span>
          <span>{formatCurrency(sale.total_discount)}</span>
        </div>
        <div className="flex justify-between text-[11px] font-bold">
          <span>Grand Total</span>
          <span>{formatCurrency(sale.grand_total)}</span>
        </div>
      </div>

      <div className="my-1 border-t border-dashed border-black" />

      <div className="flex flex-col gap-0.5 text-[9px]">
        <p className="font-semibold">Payment: {PAYMENT_MODE_LABEL[sale.payment_mode]}</p>
        {sale.payment_mode === 'split' && (
          <div className="flex flex-col gap-0.5 pl-2">
            {sale.cash_amount > 0 && (
              <div className="flex justify-between">
                <span>Cash</span>
                <span>{formatCurrency(sale.cash_amount)}</span>
              </div>
            )}
            {sale.upi_amount > 0 && (
              <div className="flex justify-between">
                <span>UPI</span>
                <span>{formatCurrency(sale.upi_amount)}</span>
              </div>
            )}
            {sale.credit_amount > 0 && (
              <div className="flex justify-between">
                <span>Credit</span>
                <span>{formatCurrency(sale.credit_amount)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
