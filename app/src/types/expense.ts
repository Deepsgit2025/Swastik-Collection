/**
 * Expenses (PHASE9.md). Standalone records — deliberately *not* linked to any
 * sale or party (section 5), so there is no `party_id`/`sale_id` here and no
 * balance to adjust on write, unlike a payment.
 */

/**
 * Fixed set rather than free text, per PHASE9.md section 1's "small fixed
 * dropdown" option: it keeps the category column clean enough for Phase 10 to
 * group a dashboard by, which free typing ("Elec", "electricity", "Light
 * bill") would quietly ruin. The doc's own examples are Rent/Electricity/
 * Staff/Misc plus an "Other" — Misc is dropped as an exact synonym of Other,
 * and Transport/Supplies added as the obvious remaining retail-shop costs.
 *
 * Section 1 says to confirm the exact list with the client if they care, so
 * treat this as a reasonable default to be corrected, not a settled taxonomy.
 * Adding one is a one-line change here; the validator and the dropdown both
 * read this array.
 */
export const EXPENSE_CATEGORIES = [
  'Rent',
  'Electricity',
  'Staff',
  'Transport',
  'Supplies',
  'Other',
] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

/** Input to `logExpense` (PHASE9.md section 2). `date` is 'YYYY-MM-DD'; the form defaults it to today. */
export interface LogExpenseInput {
  category: ExpenseCategory
  amount: number
  date: string
  note?: string | null
}

export interface ExpenseRecord {
  id: number
  category: ExpenseCategory
  amount: number
  expense_date: string
  note: string | null
  logged_by_user_id: number
  created_at: string
}

/**
 * A list row carries the logging user's name alongside the record. Section 1
 * wants logged-by visible precisely *because* both roles can log — it's how
 * the Owner sees who entered what — so the join happens in the query rather
 * than leaving the screen to resolve an id it has no way to look up.
 */
export interface ExpenseListRow extends ExpenseRecord {
  logged_by_name: string
}

/**
 * Inclusive date-range filter on `expense_date` (PHASE9.md section 1 /
 * acceptance criterion 4). Either end can stand alone: `from` only is
 * "since", `to` only is "up to", neither is everything.
 */
export interface ExpenseListFilters {
  from?: string | null
  to?: string | null
}
