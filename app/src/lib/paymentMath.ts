/**
 * Pure validation shared between the Payment-In screen (inline errors before
 * the user can submit) and `recordPayment` (the check that actually gates the
 * write) — the same two-layer discipline as `saleMath.ts`, so both layers
 * enforce identical rules instead of two hand-written copies that could
 * drift. PHASE8.md acceptance criterion 5 requires an invalid amount or a
 * missing party to be rejected "with a clear inline error before reaching the
 * database", and a modified renderer could skip its own check — hence both.
 */

import type { PaymentInMode } from '../types/payment.ts'

export const PAYMENT_MODES: PaymentInMode[] = ['cash', 'upi']

export const PAYMENT_MODE_LABELS: Record<PaymentInMode, string> = {
  cash: 'Cash',
  upi: 'UPI',
}

/** Returns an error message if the amount can't be recorded, otherwise null. */
export function validatePaymentAmount(amount: number): string | null {
  if (!Number.isFinite(amount)) return 'Enter a payment amount.'
  if (!(amount > 0)) return 'Payment amount must be greater than 0.'
  return null
}

/** Returns an error message if no party is selected, otherwise null. A payment always needs one (PHASE8.md section 1). */
export function validatePaymentParty(partyId: number | null | undefined): string | null {
  if (partyId == null || !Number.isInteger(partyId) || partyId <= 0) {
    return 'Select the party this payment is from.'
  }
  return null
}

export function validatePaymentMode(mode: string): string | null {
  if (!PAYMENT_MODES.includes(mode as PaymentInMode)) return 'Payment mode must be Cash or UPI.'
  return null
}
