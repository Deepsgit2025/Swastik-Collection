/**
 * Pure money math shared between the sale screen (client-side UX validation)
 * and `createSale` (server-side validation) — PHASE5.md section 3 requires
 * both to enforce the same rules, so this is the single source of truth for
 * them rather than two hand-written copies that could drift apart.
 *
 * Discount is a single bill-level amount (applied to the subtotal), not a
 * per-line field — see the note on `CreateSaleInput` in types/sale.ts.
 */

export interface SaleLineInput {
  itemName: string
  quantity: number
  unitPrice: number
}

/** Guards against floating-point drift (e.g. 0.1 + 0.2) without masking a real mismatch. */
const EPSILON = 0.005

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function lineTotal(item: Pick<SaleLineInput, 'quantity' | 'unitPrice'>): number {
  return roundMoney(item.quantity * item.unitPrice)
}

/** Returns an error message if the line is invalid, otherwise null. */
export function validateLine(item: SaleLineInput): string | null {
  const name = item.itemName.trim()
  if (!name) return 'Item name is required.'
  if (!(item.quantity > 0)) return `Quantity for "${name}" must be greater than 0.`
  if (!(item.unitPrice >= 0)) return `Unit price for "${name}" cannot be negative.`
  return null
}

export interface SaleTotals {
  subtotal: number
  totalDiscount: number
  grandTotal: number
}

export function computeSaleTotals(items: SaleLineInput[], discount: number): SaleTotals {
  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0))
  const totalDiscount = roundMoney(discount)
  const grandTotal = roundMoney(subtotal - totalDiscount)
  return { subtotal, totalDiscount, grandTotal }
}

/** The bill-level discount can't exceed the subtotal (can't discount below zero). */
export function validateDiscount(discount: number, subtotal: number): string | null {
  if (discount < 0) return 'Discount cannot be negative.'
  if (discount > subtotal + EPSILON) return `Discount cannot exceed the subtotal of ${subtotal.toFixed(2)}.`
  return null
}

/**
 * Split-payment sum check (PHASE5.md section 3): cash + UPI + credit must
 * exactly equal the grand total. No silent rounding or auto-adjustment — a
 * mismatch is always a blocking error.
 */
export function validateSplitTotal(
  cashAmount: number,
  upiAmount: number,
  creditAmount: number,
  grandTotal: number,
): string | null {
  if (cashAmount < 0 || upiAmount < 0 || creditAmount < 0) return 'Payment amounts cannot be negative.'

  const paid = roundMoney(cashAmount + upiAmount + creditAmount)
  if (Math.abs(paid - grandTotal) > EPSILON) {
    return `Cash + UPI + Credit (${paid.toFixed(2)}) must exactly equal the grand total (${grandTotal.toFixed(2)}).`
  }
  return null
}
