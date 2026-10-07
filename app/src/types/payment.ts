import type { PartyDetail } from './party.ts'

/**
 * Deliberately narrower than a sale's `PaymentMode` (`cash | upi | credit |
 * split`): a Payment-In is money actually arriving, so there is no "credit"
 * or "split" option to record — PHASE8.md section 1. Matches the
 * `CHECK (mode IN ('cash', 'upi'))` constraint on the `payments` table in
 * migration 002.
 */
export type PaymentInMode = 'cash' | 'upi'

/** Input to `recordPayment` (PHASE8.md section 2). A payment always needs a party — unlike a sale, which can be partyless for a pure cash bill. */
export interface RecordPaymentInput {
  partyId: number
  amount: number
  mode: PaymentInMode
  note?: string | null
}

export interface PaymentRecord {
  id: number
  party_id: number
  amount: number
  mode: PaymentInMode
  note: string | null
  recorded_by_user_id: number
  created_at: string
}

/**
 * `party` is the party record *after* `adjustPartyBalance` ran, so the screen
 * can show the new balance straight away without a second round trip
 * (PHASE8.md section 2, step 4).
 */
export interface RecordPaymentResult {
  payment: PaymentRecord
  party: PartyDetail
}
