export interface PartyListFilters {
  search?: string
  onlyWithBalanceDue?: boolean
}

export interface PartyListRow {
  id: number
  name: string
  phone: string | null
  balance: number
  created_at: string
}

export interface PartyDetail {
  id: number
  name: string
  phone: string | null
  address: string | null
  balance: number
  created_at: string
}

/** Owner-only full form (PHASE3.md section 1). `openingBalance` seeds the cache `balance` column; omitted/0 for a normal new party. */
export interface CreatePartyInput {
  name: string
  phone?: string | null
  address?: string | null
  openingBalance?: number
}

/**
 * Deliberately a separate, narrower shape from `CreatePartyInput` — no
 * address or balance field exists here at all, so the "Salesman only ever
 * gets name+phone" rule is enforced at the function signature level, not
 * just hidden in the UI (PHASE3.md section 2).
 */
export interface QuickAddPartyInput {
  name: string
  phone: string
}

/** Owner-only edit (PHASE3.md section 1). No balance field — the cached balance only ever moves via `adjustPartyBalance`, never a direct edit. */
export interface UpdatePartyInput {
  name: string
  phone?: string | null
  address?: string | null
}

export type LedgerEntryType = 'sale' | 'payment'

/**
 * `amount` is the signed delta this entry applies to the running balance —
 * a sale's credit_amount (0 for a fully cash/UPI sale) or a payment's amount
 * negated — not the sale's grand_total. This matches the cache-column rule
 * in PHASE3.md section 3 (`adjustPartyBalance`), so `runningBalance` on the
 * last entry lines up with what that function would produce. It is kept for
 * internal running-balance bookkeeping only — the UI displays `billAmount`
 * instead, since `amount` reads as ₹0 on every fully-paid cash/UPI sale.
 *
 * `billAmount` is what was actually billed: a sale's `grand_total`, or a
 * payment's `amount`. This is what the ledger table shows the owner.
 */
export interface LedgerEntry {
  type: LedgerEntryType
  id: number
  date: string
  description: string
  amount: number
  billAmount: number
  runningBalance: number
}

export interface PartyLedgerResult {
  party: PartyDetail
  entries: LedgerEntry[]
}
