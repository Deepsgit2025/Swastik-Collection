export type PaymentMode = 'cash' | 'upi' | 'credit' | 'split'

/** One cart line as sent to `createSale`. No `lineTotal` field — the server always recomputes it from these raw values rather than trusting a client-sent total (PHASE5.md section 3). */
export interface SaleItemInput {
  itemName: string
  barcode?: string | null
  quantity: number
  unitPrice: number
}

/**
 * `discount` is a single bill-level amount applied to the subtotal — not a
 * per-line field. This supersedes Phase 5's original per-line-discount
 * decision; see CLAUDE.md.
 */
export interface CreateSaleInput {
  partyId?: number | null
  /**
   * Who made this sale — a `salesmen` row, picked from the dropdown on the
   * sale screen (client decision, 2026-08-27). Optional: a bill saved without
   * one reads as "Unassigned" in every report, which the client chose over
   * blocking the counter on a field somebody forgot to set.
   *
   * **This is attribution, not an identity claim**, and so does not breach
   * CLAUDE.md's rule that identity comes from the main-process session — the
   * same distinction `reports:salesmanSales` already documents for its
   * `salesmanUserId` filter. Nothing about *who may create a sale* is decided
   * by this value; that still comes from `requireSession`. What a renderer
   * could do by forging it is credit the wrong colleague, which is the same
   * thing it could do by picking the wrong name in the dropdown.
   */
  salesmanId?: number | null
  /**
   * The salesman as typed on the sale screen (2026-09-19). When present it wins
   * over `salesmanId`: `createSale` matches it case-insensitively against the
   * salesmen list and adds it as a new salesman when nothing matches. Blank
   * means Unassigned. See `resolveSalesmanForSale` for the permission carve-out.
   */
  salesmanName?: string | null
  items: SaleItemInput[]
  discount: number
  paymentMode: PaymentMode
  cashAmount: number
  upiAmount: number
  creditAmount: number
}

export interface SaleItemRecord {
  id: number
  sale_id: number
  item_name: string
  barcode: string | null
  quantity: number
  unit_price: number
  line_total: number
}

export interface SaleRecord {
  id: number
  party_id: number | null
  /**
   * Which *session* recorded this bill — the counter account, or the Owner
   * while elevated. **Not who sold it**; that is `salesman_id`.
   *
   * Kept (and still NOT NULL) because every row written before 2026-08-27
   * carries real attribution here, and migration 012 backfills `salesman_id`
   * from exactly this column.
   */
  salesman_user_id: number
  /** Who gets the credit — a `salesmen` row. Null for a bill saved with no salesman picked, and for nothing else after migration 012's backfill. */
  salesman_id: number | null
  payment_mode: PaymentMode
  cash_amount: number
  upi_amount: number
  credit_amount: number
  subtotal: number
  total_discount: number
  grand_total: number
  whatsapp_customer_sent: number
  whatsapp_owner_sent: number
  printed: number
  print_override_used: number
  /** Audit trail for the override (migration 006) — only ever set, together, by usePrintOverride. Optional/nullable since rows before migration 006 (and any never-overridden sale) never populate them. */
  print_override_by_user_id?: number | null
  print_override_customer_sent_at_use?: number | null
  print_override_owner_sent_at_use?: number | null
  print_override_at?: string | null
  is_cash_bill: number
  archived_local: number
  purge_at: string | null
  created_at: string
  items: SaleItemRecord[]
}
