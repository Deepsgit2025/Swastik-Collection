import type Database from 'better-sqlite3'
import type {
  ExpenseListFilters,
  ExpenseListRow,
  ExpenseRecord,
  LogExpenseInput,
} from '../types/expense.ts'
import type { SafeUser } from '../types/user.ts'
import { assertPermission } from './permissions.ts'
import { roundMoney } from '../lib/saleMath.ts'
import {
  validateExpenseAmount,
  validateExpenseCategory,
  validateExpenseDate,
} from '../lib/expenseMath.ts'

const EXPENSE_COLUMNS = `id, category, amount, expense_date, note, logged_by_user_id, created_at`

/** Same columns, table-qualified for the list query's join against `users`. */
const EXPENSE_COLUMNS_QUALIFIED = `e.id, e.category, e.amount, e.expense_date, e.note, e.logged_by_user_id, e.created_at`

/**
 * Builds the inclusive `expense_date` range clause shared by `getExpenses`
 * and `getExpensesTotal`.
 *
 * Extracted rather than written twice precisely because of PHASE9.md section
 * 4: Phase 10 sums against the same ranges the list filters by, and the one
 * bug that would matter most here is a total that quietly disagrees with the
 * list it sits above — an exclusive end date in one and an inclusive end in
 * the other would do exactly that, and would look like a rounding problem.
 * One builder means the list and the total can only ever select the same rows.
 *
 * Each end is independent, so "since the 1st" and "up to the 15th" both work
 * on their own; BETWEEN would need both. Inclusive at both ends — picking the
 * same day for From and To shows that day's expenses, which is what anyone
 * filtering a single day expects, and is what lets Phase 10 ask for "today"
 * as `{ from: today, to: today }`.
 *
 * Conditions are table-qualified (`e.`), so every query using this must alias
 * `expenses` as `e`.
 */
function buildDateRangeClause(filters: ExpenseListFilters): {
  where: string
  params: unknown[]
} {
  const conditions: string[] = []
  const params: unknown[] = []

  const from = filters.from?.trim()
  if (from) {
    conditions.push('e.expense_date >= ?')
    params.push(from)
  }

  const to = filters.to?.trim()
  if (to) {
    conditions.push('e.expense_date <= ?')
    params.push(to)
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

export function getExpenseById(db: Database.Database, id: number): ExpenseRecord | null {
  const row = db.prepare(`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE id = ?`).get(id) as
    | ExpenseRecord
    | undefined
  return row ?? null
}

/**
 * The expense list (PHASE9.md section 1). No `assertPermission` gate: both
 * roles can view per the section 3 table, same as `getParties`. Requiring an
 * actual logged-in session is the IPC layer's job.
 *
 * Deliberately **not** scoped to the calling user's own rows — acceptance
 * criterion 1 is explicit that a Salesman sees the whole shop's expenses, on
 * the same reasoning as Phase 4's barcode labels: this is shop-wide financial
 * visibility, not per-user data. `logged_by_name` is joined in rather than
 * left as a bare id precisely so a shared list stays readable.
 */
export function getExpenses(
  db: Database.Database,
  filters: ExpenseListFilters = {},
): ExpenseListRow[] {
  const { where, params } = buildDateRangeClause(filters)

  // Newest first by the day the money went out, then by id DESC — several
  // expenses commonly share one `expense_date` (it has no time component at
  // all), so id is what keeps the order deterministic within a day. Same
  // tie-break reasoning as `getBarcodeLabels`.
  return db
    .prepare(
      `SELECT ${EXPENSE_COLUMNS_QUALIFIED}, u.full_name AS logged_by_name
       FROM expenses e
       JOIN users u ON u.id = e.logged_by_user_id
       ${where}
       ORDER BY e.expense_date DESC, e.id DESC`,
    )
    .all(...params) as ExpenseListRow[]
}

/**
 * Logs a new expense (PHASE9.md section 2).
 *
 * **Allowed for both roles** — `expense:create` is `['owner', 'salesman']` in
 * the central table, per the confirmed decision in PHASE9.md section 0 that
 * reversed an earlier Owner-only assumption. This is add-only: there is no
 * `updateExpense`/`deleteExpense` counterpart in this file, and
 * `expense:edit`/`expense:delete` stay Owner-only in `permissions.ts` for
 * whenever a later phase builds them (section 1 — the permission exists, the
 * screen doesn't).
 *
 * A single insert with nothing to keep in step with it, so unlike
 * `recordPayment` (payment + `adjustPartyBalance`) or `createSale` (sale +
 * items + balance) there is no transaction here: expenses are standalone
 * records with no party or sale linkage at all (section 5).
 */
export function logExpense(
  db: Database.Database,
  user: SafeUser,
  input: LogExpenseInput,
): ExpenseRecord {
  assertPermission(user.role, 'expense:create')

  const categoryError = validateExpenseCategory(input.category)
  if (categoryError) throw new Error(categoryError)

  const amount = roundMoney(input.amount)
  const amountError = validateExpenseAmount(amount)
  if (amountError) throw new Error(amountError)

  const dateError = validateExpenseDate(input.date)
  if (dateError) throw new Error(dateError)

  const result = db
    .prepare(
      `INSERT INTO expenses (category, amount, expense_date, note, logged_by_user_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    // `logged_by_user_id` comes from the session-resolved user, never from the
    // input — the renderer has no way to attribute an expense to someone else.
    .run(input.category, amount, input.date, input.note?.trim() || null, user.id)

  return getExpenseById(db, result.lastInsertRowid as number)!
}

/**
 * Sums `amount` over the same rows `getExpenses` would list for the same
 * range (PHASE9.md section 4 / acceptance criterion 5).
 *
 * Built here in Phase 9 rather than in Phase 10 so the dashboard has nothing
 * to reimplement: PHASE10.md section 3 says to reuse this, and its own
 * acceptance criterion 1 is that the dashboard's expense figure matches a
 * manual SQL sum of the day's `expenses` exactly. Phase 10 asks for "today"
 * as `{ from: today, to: today }`; Phase 11's Reports module passes a real
 * range through the identical parameter, which is why this takes the same
 * `ExpenseListFilters` the list does instead of a bespoke "today" flag.
 *
 * No `assertPermission` gate, matching `getExpenses`: the section 3 table
 * gives *both* roles the expense list, and a total is only an addition of
 * rows a Salesman can already read one by one. PHASE10.md's Owner-only
 * expense total is a statement about what the Salesman *dashboard* renders
 * (section 2 keeps it deliberately narrow), not a claim that the underlying
 * figure is secret — enforcing it here would contradict Phase 9 section 3 and
 * break the Expenses screen for the role that is allowed to see it.
 *
 * Summed in SQLite rather than by adding up `getExpenses(...)` in JS so a
 * dashboard total never depends on hydrating every row of a long date range.
 * `COALESCE` because `SUM` over no rows is NULL, not 0 — an empty day must
 * read as ₹0, and returning null would push that decision onto every caller.
 * `roundMoney` because `amount` is a REAL column: each row is stored already
 * rounded to paise, but adding a few hundred of them reintroduces exactly the
 * 0.1 + 0.2 = 0.30000000000000004 drift that would make a dashboard figure
 * fail a manual cross-check against the table.
 */
export function getExpensesTotal(
  db: Database.Database,
  range: ExpenseListFilters = {},
): number {
  const { where, params } = buildDateRangeClause(range)

  const row = db
    .prepare(`SELECT COALESCE(SUM(e.amount), 0) AS total FROM expenses e ${where}`)
    .get(...params) as { total: number }

  return roundMoney(row.total)
}
