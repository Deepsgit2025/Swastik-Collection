/**
 * Pure validation shared between the Expenses screen (inline errors before
 * the operator can submit) and `logExpense` (the check that actually gates
 * the write) — the same two-layer discipline as `saleMath.ts` and
 * `paymentMath.ts`, so the two layers enforce identical rules instead of two
 * hand-written copies that drift. The screen's copy is a convenience; the
 * backend's is the one a modified renderer still can't get past.
 */

import { EXPENSE_CATEGORIES, type ExpenseCategory } from '../types/expense.ts'
import { isValidIsoDate } from './dateRange.ts'

/**
 * Re-exported, not defined here any more: Phase 10's dashboard and Phase 11's
 * Reports both need the same "what day is it in the shop?" answer, so the
 * implementation moved to the neutral `lib/dateRange.ts` alongside
 * `todayRange()`. Kept exported from this module because the Expenses screen
 * and its tests already import it from here, and a local-day helper living in
 * two places is the drift this file's own header warns about.
 */
export { todayIsoDate } from './dateRange.ts'

/** Returns an error message if the amount can't be logged, otherwise null. */
export function validateExpenseAmount(amount: number): string | null {
  if (!Number.isFinite(amount)) return 'Enter an expense amount.'
  if (!(amount > 0)) return 'Expense amount must be greater than 0.'
  return null
}

/** Returns an error message if the category isn't one of the known ones, otherwise null. */
export function validateExpenseCategory(category: string): string | null {
  if (!EXPENSE_CATEGORIES.includes(category as ExpenseCategory)) {
    return `Choose a category: ${EXPENSE_CATEGORIES.join(', ')}.`
  }
  return null
}

/**
 * Returns an error message if the date isn't a real 'YYYY-MM-DD' day,
 * otherwise null.
 *
 * The well-formed-and-real-day test moved to `lib/dateRange.ts`'s
 * `isValidIsoDate` in Phase 11, which needs the identical check to validate the
 * Reports picker's range; the wording of the two messages is what stays here,
 * since only this screen has an "expense date" field to name. The blank/
 * malformed case is still separated from the not-a-real-day case because they
 * are different mistakes and deserve different prompts.
 *
 * A future date is deliberately allowed: rent or a supplier paid in advance is
 * a real thing to log, and blocking it to catch the rarer typo would cost more
 * than it saves.
 */
export function validateExpenseDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Enter the expense date.'
  if (!isValidIsoDate(date)) return 'That is not a real date.'
  return null
}
