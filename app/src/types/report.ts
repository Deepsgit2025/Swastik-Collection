/**
 * Shared shapes for the reporting query layer (`src/db/reports.ts`) — used by
 * Phase 10's dashboard first and Phase 11's Reports screens after, which is
 * why nothing here mentions "today": the range is always the caller's.
 */

/**
 * An inclusive date range over the shop's **local** calendar days, each end
 * 'YYYY-MM-DD'. Either end can stand alone — `from` only is "since", `to`
 * only is "up to", neither is everything.
 *
 * Deliberately structurally identical to Phase 9's `ExpenseListFilters`, so
 * the dashboard can build one range object and hand the *same* value to
 * `getTodaysSalesSummary`, `getSalesmanBreakdown` and `getExpensesTotal`
 * without a conversion step that could shift one of them by a day.
 */
export interface DateRange {
  from?: string | null
  to?: string | null
}

/**
 * The money summary for a date range (PHASE10.md sections 1–3, PHASE11.md
 * section 1).
 *
 * The split between "collected" and "issued" is the whole point of this
 * shape, and is the rule PHASE10.md section 1 spells out: **a sale's
 * `credit_amount` is not money that arrived.** It's billed, it moves the
 * party's balance, and it only becomes cash or UPI on the later day a
 * Payment-In against it is recorded. So:
 *
 *   - `salesTotal` is what was *billed* in range (`grand_total`), which is
 *     cash + UPI + credit of those sales and nothing else.
 *   - `cashCollected` / `upiCollected` are what *arrived* in range: the
 *     cash/UPI parts of this range's sales **plus** this range's Payment-In
 *     rows by mode.
 *   - `creditIssued` is new credit handed out in range; `creditCollected` is
 *     old credit cleared in range. They describe different sales and are
 *     never netted against each other here.
 *
 * The `*FromSales` / `*FromPayments` components are kept rather than folded
 * away so both halves of each split stay visible: acceptance criterion 4 is
 * specifically that the Payment-In money is included without double-counting
 * credit sales, and a single pre-added number gives nobody — a screen, a
 * test, or whoever cross-checks this against raw SQL — any way to see which
 * half is wrong.
 */
export interface SalesSummary {
  /** Number of sales in range, after any salesman filter. */
  saleCount: number
  /** Sum of `sales.grand_total` — billed, however it was paid. */
  salesTotal: number
  /** Sum of `sales.cash_amount`. */
  cashFromSales: number
  /** Sum of `sales.upi_amount`. */
  upiFromSales: number
  /** Sum of `sales.credit_amount` — billed in range, *not* collected in range. */
  creditIssued: number
  /** Payment-In rows recorded in range with `mode = 'cash'`. */
  cashFromPayments: number
  /** Payment-In rows recorded in range with `mode = 'upi'`. */
  upiFromPayments: number
  /** `cashFromPayments + upiFromPayments` — credit cleared in range, whenever the sale behind it happened. */
  creditCollected: number
  /** `cashFromSales + cashFromPayments` — the dashboard's "Cash" figure. */
  cashCollected: number
  /** `upiFromSales + upiFromPayments` — the dashboard's "UPI" figure. */
  upiCollected: number
  /** `cashCollected + upiCollected` — every rupee that actually arrived in range. */
  totalCollected: number
}

/**
 * One row of the Owner-only salesman-wise breakdown (PHASE10.md section 3).
 *
 * Purely a view of `sales`, grouped by `salesman_id` — Payment-In rows are
 * **not** folded in here, unlike `SalesSummary`'s collected figures. Section 1
 * defines this table as "today's sales total per salesman", and a payment
 * collected against a credit sale someone else made is not that person's sale.
 *
 * Grouped by `salesman_user_id` until 2026-08-27, when attribution moved off
 * logins onto the `salesmen` table. The figures a given person's row reports
 * are unchanged across that move — migration 012 backfills `salesman_id` from
 * exactly the column this used to group by.
 *
 * `cashTotal + upiTotal + creditTotal === total` for every row, by
 * construction — `createSale` refuses any sale where those three don't sum
 * to the grand total.
 */
export interface SalesmanBreakdownRow {
  /**
   * The `salesmen` row this total belongs to, or **null for the unassigned
   * bucket** — the bills saved with no salesman picked, which is a legal
   * outcome since 2026-08-27 and so a legitimate row here rather than an
   * anomaly. Was `salesmanUserId` (a `users` id) until attribution moved off
   * logins on that date.
   */
  salesmanId: number | null
  /** The salesman's name, or `UNASSIGNED_SALESMAN_LABEL` for the null bucket — substituted in SQL so every screen says the same word. */
  salesmanName: string
  saleCount: number
  /** Sum of `grand_total` for this salesman's sales in range. */
  total: number
  cashTotal: number
  upiTotal: number
  creditTotal: number
}

/**
 * Everything the Owner dashboard renders, assembled main-side in one call
 * (PHASE10.md section 1).
 *
 * One payload rather than four separate channels because every figure on that
 * screen is meant to describe the *same* window: four independent round trips
 * could straddle midnight, or a sale landing mid-fetch, and show a sales total
 * and an expense total measured over different days. `range` is echoed back
 * for the same reason — the screen labels the day it actually measured rather
 * than the day it assumed.
 */
export interface OwnerDashboardData {
  /** The range these figures were measured over — `todayRange()` in this phase, a picker's range in Phase 11. */
  range: DateRange
  /** SQLite `datetime('now')`-style stamp of when the numbers were read, for the "Updated at …" line beside Refresh. */
  generatedAt: string
  summary: SalesSummary
  salesmanBreakdown: SalesmanBreakdownRow[]
  /** Live snapshot of positive `parties.balance`, deliberately *not* scoped to `range`. */
  outstandingCredit: number
  expenseTotal: number
}

/*
 * `SalesmanDashboardData` stood here until 2026-08-27, describing one
 * salesman's own day. It was removed with the salesman login: nobody logs in
 * as a salesman any more, so there is no session whose "own" day it could
 * describe. The Owner's per-person view is `SalesmanBreakdownRow`.
 */

/**
 * One individual sale in the Salesman-wise report's drill-down (PHASE11.md
 * section 1) — the rows behind a single cell of `getSalesmanBreakdown`.
 *
 * Section 1 asks for "item count, total, payment mode, timestamp". The party
 * and the cash/UPI/credit split are here too because this is what the CSV
 * carries to an accountant, and a list of totals with no indication of what was
 * on credit is not a thing anyone can reconcile.
 *
 * `partyName` is null for a cash sale with no party attached — `sales.party_id`
 * is nullable by design, and a walk-in is the common case rather than an
 * anomaly.
 */
export interface SalesmanSaleRow {
  saleId: number
  /** SQLite `datetime('now')`-shaped stamp (UTC) — render through `formatDate`. */
  createdAt: string
  partyName: string | null
  /** Number of `sale_items` rows on this bill. */
  itemCount: number
  paymentMode: string
  /** `sales.grand_total` — cash + UPI + credit of this sale, by construction. */
  grandTotal: number
  cashAmount: number
  upiAmount: number
  creditAmount: number
}

/**
 * One party in the Party Outstanding Report (PHASE11.md sections 1 and 3).
 *
 * `balance` is positive when the party owes the shop and **negative when they
 * have overpaid**, and both appear in this list: acceptance criterion 3 asks
 * for "every party with a non-zero balance". The report's own total is
 * `PartyOutstandingReportData.outstandingTotal`, which counts positives only —
 * see there for why the two are not the same number and must not be.
 */
export interface PartyOutstandingRow {
  partyId: number
  partyName: string
  phone: string | null
  balance: number
}

/**
 * The Daily Sales Report (PHASE11.md section 1) — the same `SalesSummary` the
 * Owner dashboard renders, over a caller-chosen range instead of today.
 *
 * **`SalesSummary` deliberately gains no fields for this phase.** Acceptance
 * criterion 1 is that this report narrowed to today produces numbers identical
 * to Phase 10's dashboard, and the cleanest way to guarantee that is for both
 * to be the same shape out of the same function — section 1's four asks (total
 * sales, cash/UPI split, credit issued, credit collected) are all already on
 * it. No expense total: section 1 does not list one, and the Expenses screen
 * already ranges over its own data.
 */
export interface DailySalesReportData {
  /** Echoed back so the screen labels the window it actually measured, not the one it assumed. */
  range: DateRange
  generatedAt: string
  summary: SalesSummary
  /**
   * The earliest date cash bills are still guaranteed present, or null when
   * nothing has ever been purged (PHASE12.md section 3).
   *
   * Once the retention job has removed anything, a report reaching further back
   * than this under-reports cash sales — not because the query is wrong, but
   * because the bills are gone by policy. The screen says so, so an Owner
   * comparing a long range against their memory concludes "that is the 90-day
   * rule" rather than "the app lost my sales".
   *
   * Null until a bill is actually purged, so a shop that never switched
   * retention on never sees the note.
   */
  cashRetentionCutoff: string | null
}

/** The Salesman-wise report's top-level table (PHASE11.md section 1) — `getSalesmanBreakdown` over a chosen range. */
export interface SalesmanReportData {
  range: DateRange
  generatedAt: string
  rows: SalesmanBreakdownRow[]
  /**
   * The earliest date cash bills are still guaranteed present, or null when
   * nothing has ever been purged (PHASE12.md section 3).
   *
   * Once the retention job has removed anything, a report reaching further back
   * than this under-reports cash sales — not because the query is wrong, but
   * because the bills are gone by policy. The screen says so, so an Owner
   * comparing a long range against their memory concludes "that is the 90-day
   * rule" rather than "the app lost my sales".
   *
   * Null until a bill is actually purged, so a shop that never switched
   * retention on never sees the note.
   */
  cashRetentionCutoff: string | null
}

/**
 * The Party Outstanding Report (PHASE11.md section 1) — a live snapshot, with
 * no `range` field at all because what is owed is owed regardless of when the
 * sale behind it happened.
 *
 * **`outstandingTotal` is not the sum of `rows`, and that is deliberate.** It
 * comes from `getOutstandingCreditTotal` — the same figure the Owner dashboard
 * shows — which sums positive balances only, because a party sitting on an
 * advance must not cancel out a different party's debt. `rows` additionally
 * carries the overpaid parties, since criterion 3 asks for every non-zero
 * balance. So the total equals the sum of the *positive* rows, and the screen
 * says as much rather than leaving a reader to wonder why the column does not
 * add up to the footer.
 *
 * Both are read inside one composer so they describe one instant: read
 * separately, a Payment-In landing between them would split the snapshot and
 * make criterion 3 fail for a reason that has nothing to do with the query.
 */
export interface PartyOutstandingReportData {
  generatedAt: string
  rows: PartyOutstandingRow[]
  /** Positive balances only — matches `getOutstandingCreditTotal` and the dashboard's "Outstanding Credit" card. */
  outstandingTotal: number
}

/**
 * Outcome of a CSV export (PHASE11.md section 2).
 *
 * `saved: false` is the operator dismissing the save dialog — a normal
 * decision, not a fault, so the screen reports nothing rather than an error.
 * `filePath` is echoed back on success so the screen can name where the file
 * went; an Owner who accepts a default filename in a folder they didn't choose
 * otherwise has to go hunting for it.
 */
export interface ExportCsvResult {
  saved: boolean
  filePath: string | null
}

/**
 * One bill in the Sales module's table (client request, 2026-08-27) — the flat
 * shop-wide list, as opposed to `SalesmanSaleRow`, which is one person's bills
 * under a breakdown row.
 *
 * The client asked for three columns: customer name, amount, salesman. `saleId`
 * and `createdAt` are here as well because a row in a month's list has to be
 * identifiable — "₹230 to a walk-in by Ramesh" describes a dozen bills
 * otherwise — and `paymentMode` because a list of amounts that doesn't say
 * which were on credit is not something an Owner can reconcile against the
 * till. All five are cheap: they come off the `sales` row the query already
 * reads.
 */
export interface SalesLedgerRow {
  saleId: number
  /** SQLite `datetime('now')`-shaped stamp (UTC) — render through `formatDate`. */
  createdAt: string
  /** Null for a walk-in — `sales.party_id` is nullable by design and a walk-in is the ordinary case. */
  partyName: string | null
  /** Null for a bill saved with no salesman picked; `salesmanName` then carries `UNASSIGNED_SALESMAN_LABEL`. */
  salesmanId: number | null
  salesmanName: string
  paymentMode: string
  grandTotal: number
}
