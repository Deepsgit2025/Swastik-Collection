/**
 * The reporting query layer — Phase 10's dashboard reads from here, and
 * Phase 11's Reports screens are meant to read from the *same* functions
 * with a wider range rather than growing a parallel set (PHASE10.md section
 * 3, PHASE11.md section 3). Nothing in this file hardcodes "today": every
 * range-scoped function takes an explicit `DateRange`, and the dashboard's
 * "today" is just `todayRange()` supplied by the caller.
 *
 * Read-only — there is no write function here and none belongs here. But the
 * permission discipline is the same as the write layer's: every function calls
 * `assertPermission(user.role, 'report:view_all')` before it queries. That is
 * deliberately unlike `getParties`/`getExpenses`, which are ungated because the
 * counter needs them; here the whole point is that shop-wide money is
 * unreachable without an Owner session, and PHASE10.md section 4 is explicit
 * that this must hold against the *call*, not against what the screen chooses
 * to render.
 *
 * Since 2026-08-27 that is the *only* gate here — `report:view_own` and the
 * per-salesman narrowing it guarded went with the salesman login. The screens
 * in front of these functions are reached through the Owner password gate, and
 * these assertions are what makes that gate real rather than cosmetic: a
 * renderer that skipped the prompt is still the counter session server-side and
 * still gets a `PermissionError` here.
 */

import type Database from 'better-sqlite3'
import type {
  DateRange,
  OwnerDashboardData,
  SalesLedgerRow,
  SalesSummary,
  SalesmanBreakdownRow,
} from '../types/report.ts'
import type {
  DailySalesReportData,
  PartyOutstandingReportData,
  PartyOutstandingRow,
  SalesmanReportData,
  SalesmanSaleRow,
} from '../types/report.ts'
import type { SafeUser } from '../types/user.ts'
import { assertPermission } from './permissions.ts'
import { getExpensesTotal } from './expenses.ts'
import { roundMoney } from '../lib/saleMath.ts'
import { hasPurgedAnyBill } from './retention.ts'
import { retentionCutoffDate } from '../lib/retention.ts'

/**
 * Builds the inclusive range clause for a **UTC-stored timestamp** column,
 * matched against the shop's **local** calendar days.
 *
 * `date(col, 'localtime')` is doing real work here and must not be simplified
 * away. `sales.created_at` and `payments.created_at` are written by SQLite's
 * `datetime('now')`, which is UTC (`lib/format.ts` says the same where it
 * parses these values back). The shop's day is local. In IST those are 5.5
 * hours apart, so a bare `date(created_at)` would make "today" run from 05:30
 * today to 05:30 tomorrow: every sale rung up before half past five in the
 * morning would land on yesterday's dashboard, and last night's late sales on
 * today's. `'localtime'` converts each row's stamp to the machine's own
 * timezone first, so a day here means the day the shop was actually open — and
 * lines up with `expenses.expense_date`, which Phase 9 already stores as a
 * *local* 'YYYY-MM-DD' via `todayIsoDate`. Without that, the dashboard's
 * expense total and its sales total would be measuring two different days.
 *
 * The cost is that these comparisons can't use an index on `created_at`. There
 * is no such index today, and a shop's sales table grows by a few tens of
 * thousands of rows a year — a scan is not what will ever be slow here, while
 * a wrong day boundary is a number the Owner would act on.
 *
 * Anyone hand-checking a dashboard figure against raw SQL (PHASE10.md
 * acceptance criterion 1) has to apply the same `'localtime'` conversion, or
 * the two will disagree by whatever happened in that 5.5-hour band.
 *
 * `column` is always a literal from this file, never caller input.
 */
function buildLocalDayRangeClause(
  column: string,
  range: DateRange,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  const from = range.from?.trim()
  if (from) {
    conditions.push(`date(${column}, 'localtime') >= ?`)
    params.push(from)
  }

  const to = range.to?.trim()
  if (to) {
    conditions.push(`date(${column}, 'localtime') <= ?`)
    params.push(to)
  }

  return { conditions, params }
}

function whereFrom(conditions: string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
}

/**
 * What a bill with no salesman picked reads as (2026-08-27 — the field is
 * optional by client decision).
 *
 * Substituted in SQL rather than left null for the screen to interpret, so
 * every consumer — the breakdown table, the sales ledger, the CSV export —
 * says the same word. A blank cell would read as a rendering bug; this reads
 * as the fact it is.
 */
export const UNASSIGNED_SALESMAN_LABEL = 'Unassigned'

/**
 * Money summary for a date range, shop-wide.
 *
 * It carried an optional `salesmanUserId` filter until 2026-08-27, for the
 * Salesman dashboard (PHASE10.md section 3). That dashboard and the salesman
 * login behind it are both gone, so the parameter went with them.
 *
 * **The cash/UPI rule this function exists to get right** (PHASE10.md section
 * 1): a sale's `cash_amount`/`upi_amount` is money that arrived when the sale
 * happened, and a Payment-In is money that arrived when it was recorded —
 * both count. A sale's `credit_amount` is *not* cash or UPI collected; it is a
 * receivable. It appears as `creditIssued`, it moves the party's balance, and
 * it becomes collected money only on the later day someone records a
 * Payment-In against it — at which point it is counted once, here, as
 * `cashFromPayments`/`upiFromPayments`. That is the whole anti-double-count
 * story: the two sources add disjoint amounts, so `cashCollected` and
 * `upiCollected` cannot count the same rupee twice however the range is
 * chosen.
 *
 * Two queries rather than one union: `sales` and `payments` are filtered on
 * different columns, summed over different columns, and narrowed by different
 * user columns. A union would have to reconcile two shapes and would be harder
 * to check against the tables by hand than the thing it replaced.
 *
 * ### Permission
 * `report:view_all`, unconditionally — Owner only.
 *
 * It used to be `report:view_own` with an optional `salesmanUserId` that let a
 * Salesman session ask for its own figures and nothing wider. Both are gone as
 * of 2026-08-27: with no salesman login there is no "own" to scope to, the
 * Salesman dashboard that consumed it no longer exists, and every figure this
 * returns is shop-wide. The narrowing that replaced it is the Owner password
 * gate in front of the screens, not a parameter here.
 *
 * @param range Inclusive local-day range. The dashboard passes `todayRange()`;
 *   Phase 11 passes its picker's range. Nothing is defaulted here — an omitted
 *   end means open-ended, exactly as it does for `getExpenses`.
 */
export function getTodaysSalesSummary(
  db: Database.Database,
  user: SafeUser,
  range: DateRange,
): SalesSummary {
  assertPermission(user.role, 'report:view_all')

  const sales = buildLocalDayRangeClause('s.created_at', range)

  const salesRow = db
    .prepare(
      `SELECT COUNT(*) AS saleCount,
              COALESCE(SUM(s.grand_total), 0) AS salesTotal,
              COALESCE(SUM(s.cash_amount), 0) AS cashFromSales,
              COALESCE(SUM(s.upi_amount), 0) AS upiFromSales,
              COALESCE(SUM(s.credit_amount), 0) AS creditIssued
       FROM sales s
       ${whereFrom(sales.conditions)}`,
    )
    .get(...sales.params) as {
    saleCount: number
    salesTotal: number
    cashFromSales: number
    upiFromSales: number
    creditIssued: number
  }

  const payments = buildLocalDayRangeClause('p.created_at', range)

  // Bucketed by mode in SQL rather than by hydrating rows and reducing in JS,
  // same reasoning as `getExpensesTotal`: a dashboard figure should never
  // depend on loading every payment in the range. `payments.mode` is
  // constrained to 'cash' | 'upi' by the table's own CHECK, so these two cases
  // are exhaustive — there is no third bucket for money to disappear into.
  const paymentRow = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN p.mode = 'cash' THEN p.amount ELSE 0 END), 0) AS cashFromPayments,
              COALESCE(SUM(CASE WHEN p.mode = 'upi' THEN p.amount ELSE 0 END), 0) AS upiFromPayments
       FROM payments p
       ${whereFrom(payments.conditions)}`,
    )
    .get(...payments.params) as { cashFromPayments: number; upiFromPayments: number }

  // Every figure goes through `roundMoney`, for the reason Phase 9's expense
  // total documents: these are REAL columns holding values already rounded to
  // paise, but summing a few hundred of them reintroduces 0.1 + 0.2 drift, and
  // a dashboard reading 1234.5600000001 fails its own manual cross-check. The
  // derived totals are added from the already-rounded parts, so the arithmetic
  // the screen displays adds up exactly as displayed.
  const cashFromSales = roundMoney(salesRow.cashFromSales)
  const upiFromSales = roundMoney(salesRow.upiFromSales)
  const cashFromPayments = roundMoney(paymentRow.cashFromPayments)
  const upiFromPayments = roundMoney(paymentRow.upiFromPayments)

  const cashCollected = roundMoney(cashFromSales + cashFromPayments)
  const upiCollected = roundMoney(upiFromSales + upiFromPayments)

  return {
    saleCount: salesRow.saleCount,
    salesTotal: roundMoney(salesRow.salesTotal),
    cashFromSales,
    upiFromSales,
    creditIssued: roundMoney(salesRow.creditIssued),
    cashFromPayments,
    upiFromPayments,
    creditCollected: roundMoney(cashFromPayments + upiFromPayments),
    cashCollected,
    upiCollected,
    totalCollected: roundMoney(cashCollected + upiCollected),
  }
}

/**
 * Per-salesman sales totals for a range (PHASE10.md section 3, acceptance
 * criterion 2) — **Owner only**.
 *
 * Attribution is `sales.salesman_user_id`, the value `createSale` writes from
 * the session-resolved user, so a sale is credited to whoever actually rang it
 * up and there is nothing a renderer could pass to change that. The Owner
 * appears in this list too when they make a sale themselves: "salesman" here
 * means the person who created the sale, not the role.
 *
 * Grouped over `sales`, so someone who sold nothing in the range has no row
 * rather than a zero one — section 1 defines this as "today's sales total per
 * salesman (group `sales` by `salesman_user_id`, join to `users`)", and a list
 * of everyone who didn't sell isn't what a day's breakdown is for. The inner
 * join is safe: `salesman_user_id` is `NOT NULL REFERENCES users(id)`.
 *
 * Payment-In rows are deliberately not folded in — see the note on
 * `SalesmanBreakdownRow`.
 *
 * Biggest seller first, name as the tie-break so the order can't shuffle
 * between renders — the same determinism reasoning as `getExpenses`' id
 * tie-break within a day.
 */
export function getSalesmanBreakdown(
  db: Database.Database,
  user: SafeUser,
  range: DateRange,
): SalesmanBreakdownRow[] {
  assertPermission(user.role, 'report:view_all')

  const { conditions, params } = buildLocalDayRangeClause('s.created_at', range)

  const rows = db
    .prepare(
      // LEFT JOIN, and grouped on `salesman_id` rather than
      // `salesman_user_id`: attribution moved to the `salesmen` table on
      // 2026-08-27, and a bill saved with no salesman picked is now a legal
      // outcome. An inner join would make those bills vanish from the
      // breakdown while still counting towards the shop total, so the two
      // screens would silently disagree — they collapse into one
      // `UNASSIGNED_SALESMAN_LABEL` row instead, which is visible and adds up.
      `SELECT s.salesman_id AS salesmanId,
              COALESCE(sm.name, ?) AS salesmanName,
              COUNT(*) AS saleCount,
              COALESCE(SUM(s.grand_total), 0) AS total,
              COALESCE(SUM(s.cash_amount), 0) AS cashTotal,
              COALESCE(SUM(s.upi_amount), 0) AS upiTotal,
              COALESCE(SUM(s.credit_amount), 0) AS creditTotal
       FROM sales s
       LEFT JOIN salesmen sm ON sm.id = s.salesman_id
       ${whereFrom(conditions)}
       GROUP BY s.salesman_id, salesmanName
       ORDER BY total DESC, salesmanName COLLATE NOCASE ASC`,
    )
    .all(UNASSIGNED_SALESMAN_LABEL, ...params) as SalesmanBreakdownRow[]

  return rows.map((row) => ({
    ...row,
    total: roundMoney(row.total),
    cashTotal: roundMoney(row.cashTotal),
    upiTotal: roundMoney(row.upiTotal),
    creditTotal: roundMoney(row.creditTotal),
  }))
}

/**
 * The individual sales behind one salesman's row in the breakdown above
 * (PHASE11.md section 1's drill-down, acceptance criterion 2) — **Owner
 * only**, new in Phase 11.
 *
 * Filtered by the **same** `buildLocalDayRangeClause('s.created_at', range)`
 * the breakdown uses, which is the whole reason these two can be trusted to
 * agree: the drill-down must list exactly the rows the total counted, and a
 * second hand-written day-boundary clause here would drift from that by
 * whatever the timezone band happens to be. Summing `grandTotal` over these
 * rows equals that salesman's `total` in `getSalesmanBreakdown` for the same
 * range, which is what criterion 2 asks for and what a test pins.
 *
 * ### Permission
 * `report:view_all` **unconditionally** — deliberately stricter than
 * `getTodaysSalesSummary`, which lets either role ask for its own figures.
 * PHASE11.md section 0 is explicit that the Reports module "is not reachable by
 * a Salesman session at all, not even in a read-only capacity", so a Salesman
 * asking for their *own* drill-down is rejected here even though the same
 * person can see their own totals on their dashboard. That is the spec, not an
 * oversight: the dashboard shows a salesman their day, and this module is the
 * Owner's view of everyone.
 *
 * `salesmanId` is a filter, not an identity claim — see the note on the
 * `reports:salesmanSales` IPC handler for why that does not conflict with
 * CLAUDE.md's rule about renderer-supplied users.
 *
 * @param salesmanId Whose sales to list — `sales.salesman_id`, the `salesmen`
 *   row picked on the sale screen. **Null means the unassigned bucket**, the
 *   bills saved with no salesman chosen, which is a row in the breakdown like
 *   any other and must drill down like one. Payment-In rows are **not** folded
 *   in, matching `getSalesmanBreakdown`: this drills into a cell of that table,
 *   so it must describe the same thing that cell does.
 */
export function getSalesmanSales(
  db: Database.Database,
  user: SafeUser,
  salesmanId: number | null,
  range: DateRange,
): SalesmanSaleRow[] {
  assertPermission(user.role, 'report:view_all')

  const { conditions, params } = buildLocalDayRangeClause('s.created_at', range)
  // `IS NULL`, not `= ?`, for the unassigned bucket — SQL equality against
  // NULL matches nothing, so a parameterised `= NULL` would return an empty
  // drill-down under a breakdown row showing real money.
  if (salesmanId == null) {
    conditions.push('s.salesman_id IS NULL')
  } else {
    conditions.push('s.salesman_id = ?')
    params.push(salesmanId)
  }

  const rows = db
    .prepare(
      // The item count is a scalar subquery, **not** a JOIN on sale_items with
      // a GROUP BY. A join fans the bill out to one row per line, which would
      // multiply every SUM here by the line count and make a three-item sale
      // read as three times its value — the drill-down would then disagree with
      // the breakdown row it opened from, for a reason nothing on screen shows.
      `SELECT s.id AS saleId,
              s.created_at AS createdAt,
              p.name AS partyName,
              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS itemCount,
              s.payment_mode AS paymentMode,
              s.grand_total AS grandTotal,
              s.cash_amount AS cashAmount,
              s.upi_amount AS upiAmount,
              s.credit_amount AS creditAmount
       FROM sales s
       LEFT JOIN parties p ON p.id = s.party_id
       ${whereFrom(conditions)}
       ORDER BY s.created_at DESC, s.id DESC`,
    )
    .all(...params) as SalesmanSaleRow[]

  // LEFT JOIN, because `sales.party_id` is nullable — a walk-in cash sale has
  // no party, and that is the ordinary case rather than an anomaly. Newest
  // first with an id tie-break, so two sales rung up in the same second can't
  // shuffle between renders (the same determinism reasoning as `getExpenses`).
  return rows.map((row) => ({
    ...row,
    grandTotal: roundMoney(row.grandTotal),
    cashAmount: roundMoney(row.cashAmount),
    upiAmount: roundMoney(row.upiAmount),
    creditAmount: roundMoney(row.creditAmount),
  }))
}

/**
 * Total outstanding credit across all parties (PHASE10.md section 3,
 * acceptance criterion 5) — **Owner only**.
 *
 * A live snapshot of `parties.balance` as of now, deliberately **not**
 * date-ranged: section 1 calls that out explicitly, and it is the one figure
 * on the dashboard that isn't about a window of time. What is owed is owed
 * regardless of when the sale behind it happened, so there is no `DateRange`
 * parameter here and Phase 11 reuses it unchanged (its Party Outstanding
 * Report shows the same snapshot broken down per party).
 *
 * `WHERE balance > 0` matters: `balance` is positive when the party owes the
 * shop, and a party who has overpaid sits at a negative one. Summing
 * everything would let one customer's advance silently cancel out another
 * customer's debt and understate what the shop is actually owed — different
 * people, amounts that don't offset. Section 1's wording is "sum of all
 * `parties.balance` where positive".
 *
 * Reads the cached `balance` column rather than recomputing from sales and
 * payments: that column is the ledger's source of truth, written inside the
 * same transaction as every credit sale and every Payment-In by
 * `adjustPartyBalance`, and `getPartyLedger` already runs its running balance
 * off the same rule.
 */
export function getOutstandingCreditTotal(db: Database.Database, user: SafeUser): number {
  assertPermission(user.role, 'report:view_all')

  const row = db
    .prepare('SELECT COALESCE(SUM(balance), 0) AS total FROM parties WHERE balance > 0')
    .get() as { total: number }

  return roundMoney(row.total)
}

/**
 * The per-party breakdown behind that total (PHASE11.md sections 1 and 3) —
 * **Owner only**, new in Phase 11.
 *
 * A live snapshot with no `DateRange` parameter, for the same reason
 * `getOutstandingCreditTotal` has none: what is owed is owed regardless of when
 * the sale behind it happened.
 *
 * ### Why `!= 0` is not enough, and `ROUND(balance, 2) != 0` is
 * `adjustPartyBalance` (`src/db/parties.ts`) updates this column with `balance
 * = balance + ?` **in SQL, with no rounding** — it is the one money path in
 * this codebase that does not pass through `roundMoney`, because the running
 * balance is accumulated by the database rather than computed in JS. So a party
 * billed ₹400.10 on credit who then pays exactly ₹400.10 does not necessarily
 * land on 0; they land on something like 2.8e-14. A bare `balance != 0` is true
 * for that, and the report would carry a fully-settled customer as an
 * outstanding row rendering as "₹0.00" — an Owner chasing a debt that does not
 * exist. Rounding to paise before the comparison asks the question the shop
 * actually means: does this party owe or hold anything a rupee note could
 * settle?
 *
 * ### Why this returns overpaid parties too
 * Acceptance criterion 3 asks for "every party with a non-zero balance", so a
 * party carrying an advance (negative balance) gets a row. They sort last under
 * `balance DESC`, which is the natural place for them. Note this means the
 * column does **not** sum to `getOutstandingCreditTotal` — that figure counts
 * positives only, on purpose, so one customer's advance cannot mask another's
 * debt. `getPartyOutstandingReport` returns both numbers together and the
 * screen labels the difference rather than leaving it to be discovered.
 */
export function getPartyOutstandingList(
  db: Database.Database,
  user: SafeUser,
): PartyOutstandingRow[] {
  assertPermission(user.role, 'report:view_all')

  const rows = db
    .prepare(
      `SELECT id AS partyId, name AS partyName, phone, balance
       FROM parties
       WHERE ROUND(balance, 2) != 0
       ORDER BY balance DESC, name COLLATE NOCASE ASC`,
    )
    .all() as PartyOutstandingRow[]

  // Name tie-break so two parties owing the same amount keep a stable order
  // between renders — and so the CSV an accountant diffs week to week doesn't
  // reshuffle rows that didn't change.
  return rows.map((row) => ({ ...row, balance: roundMoney(row.balance) }))
}

/**
 * Read the clock from SQLite rather than from JS, so the "Updated at …" stamp
 * comes off the same clock that writes `created_at` on every sale and payment.
 * A stamp from `new Date()` would be a second or two out from the rows it
 * claims to summarise, and formatted by a different code path than every other
 * timestamp on screen — `formatDate` (src/lib/format.ts) parses exactly this
 * shape.
 */
function nowStamp(db: Database.Database): string {
  const row = db.prepare("SELECT datetime('now') AS now").get() as { now: string }
  return row.now
}

/**
 * Everything the Owner dashboard shows, in one call (PHASE10.md section 1).
 *
 * Assembled here rather than in the screen so all four figures are read inside
 * one IPC round trip against one connection: four separate calls could span
 * midnight, or a sale committed mid-sequence, and put a sales total next to an
 * expense total that describe different days.
 *
 * The **same `range` object** is handed to all three range-scoped queries. That
 * is not incidental tidiness — `getExpensesTotal` treats an omitted range as
 * *all time*, so a version of this that let any one call fall back to a default
 * would quietly show today's sales beside every expense ever logged (the trap
 * `src/lib/dateRange.ts` documents). `getOutstandingCreditTotal` takes no range
 * on purpose: what is owed is owed regardless of when the sale behind it
 * happened.
 *
 * ### Permission
 * `report:view_all` is asserted here as the first line, before any query runs.
 * Each of the three Owner-only primitives asserts it again on its own, so this
 * is deliberately redundant — the point is that the *channel* fails outright
 * for a Salesman session rather than part-way through, and that the Owner-only
 * nature of this composer is visible at its top instead of inferred from what
 * it happens to call.
 */
export function getOwnerDashboard(
  db: Database.Database,
  user: SafeUser,
  range: DateRange,
): OwnerDashboardData {
  assertPermission(user.role, 'report:view_all')

  return {
    range,
    generatedAt: nowStamp(db),
    summary: getTodaysSalesSummary(db, user, range),
    salesmanBreakdown: getSalesmanBreakdown(db, user, range),
    outstandingCredit: getOutstandingCreditTotal(db, user),
    expenseTotal: getExpensesTotal(db, range),
  }
}

/**
 * Every bill in a range, one row each — the Sales module's table (client
 * request, 2026-08-27: "it shows customer name, amount and salesman").
 *
 * Distinct from `getSalesmanSales` above, which lists **one** person's bills as
 * the drill-down under a breakdown row. This is the flat shop-wide list the
 * Owner sorts by salesman to see the day at a glance, so it carries the
 * salesman name on every row rather than being scoped to one.
 *
 * Filtered by the **same** `buildLocalDayRangeClause('s.created_at', range)`
 * every other range-scoped query here uses, which is what lets the Sales
 * screen's per-salesman totals strip (`getSalesmanBreakdown`, over the same
 * range) be the sum of the rows below it. A second hand-written day-boundary
 * clause would drift by whatever the timezone band happens to be, and the two
 * halves of one screen would disagree.
 *
 * No `LIMIT`: the range is bounded by `assertValidRange` at the IPC layer, and
 * a month of one shop's bills is a few hundred rows. Sorting is left to the
 * screen for the same reason — re-querying on every column-header click would
 * be slower than sorting an array that is already in the renderer.
 */
export function getSalesLedger(db: Database.Database, user: SafeUser, range: DateRange): SalesLedgerRow[] {
  assertPermission(user.role, 'report:view_all')

  const { conditions, params } = buildLocalDayRangeClause('s.created_at', range)

  const rows = db
    .prepare(
      // Both joins are LEFT: `party_id` is null for a walk-in (the ordinary
      // case) and `salesman_id` is null for a bill saved with nobody picked.
      // An inner join on either would drop real sales out of a list whose
      // whole job is to account for all of them.
      `SELECT s.id AS saleId,
              s.created_at AS createdAt,
              p.name AS partyName,
              s.salesman_id AS salesmanId,
              COALESCE(sm.name, ?) AS salesmanName,
              s.payment_mode AS paymentMode,
              s.grand_total AS grandTotal
       FROM sales s
       LEFT JOIN parties p ON p.id = s.party_id
       LEFT JOIN salesmen sm ON sm.id = s.salesman_id
       ${whereFrom(conditions)}
       ORDER BY s.created_at DESC, s.id DESC`,
    )
    .all(UNASSIGNED_SALESMAN_LABEL, ...params) as SalesLedgerRow[]

  return rows.map((row) => ({ ...row, grandTotal: roundMoney(row.grandTotal) }))
}

/*
 * `getSalesmanDashboard` stood here until 2026-08-27. It answered "one
 * salesman's own day" for the Salesman dashboard, and both were removed with
 * the salesman login: with nobody logging in as a salesman there is no session
 * whose "own" day this could mean. The Owner's view of each person's day is
 * `getSalesmanBreakdown`, which now groups by `salesmen` rather than by login.
 */


/* ------------------------------------------------------------------------- *
 * Phase 11 — Reports composers (PHASE11.md section 1), all Owner-only.
 *
 * Each mirrors `getOwnerDashboard`'s shape for the same three reasons: assert
 * `report:view_all` at the top so the Owner-only nature of the channel is
 * visible where it is read rather than inferred from what it happens to call;
 * echo `range` back so the screen labels the window it actually measured; and
 * stamp `generatedAt` off SQLite's clock, the same one that writes every
 * `created_at`.
 *
 * The underlying queries are Phase 10's, unchanged and un-duplicated —
 * PHASE11.md section 3's instruction. These add a range the caller chose and
 * nothing else.
 * ------------------------------------------------------------------------- */

/**
 * The Daily Sales Report (PHASE11.md section 1) — total sales, cash/UPI split,
 * credit issued, credit collected, over any range.
 *
 * Calls `getTodaysSalesSummary` — the same call `getOwnerDashboard` makes. **That identity is the point**:
 * acceptance criterion 1 requires this report narrowed to today to produce
 * numbers indistinguishable from Phase 10's dashboard, and the only way to
 * guarantee that permanently is for both to reach one function through one
 * argument shape. Anything computed differently here — even a figure that
 * looks equivalent — is a place the two can drift, and criterion 1 exists
 * precisely because that drift would be invisible until an Owner noticed two
 * screens disagreeing about the same day.
 */
/**
 * The date cash bills are still guaranteed present from, or null when nothing
 * has ever been purged (PHASE12.md section 3).
 *
 * Keyed off `purge_log` rather than off the retention *setting*, so the note
 * appears because bills really are missing — not merely because the feature
 * exists. A shop that never switched retention on never sees it.
 */
function cashRetentionCutoff(db: Database.Database): string | null {
  return hasPurgedAnyBill(db) ? retentionCutoffDate() : null
}

export function getDailySalesReport(
  db: Database.Database,
  user: SafeUser,
  range: DateRange,
): DailySalesReportData {
  assertPermission(user.role, 'report:view_all')

  return {
    range,
    generatedAt: nowStamp(db),
    summary: getTodaysSalesSummary(db, user, range),
    cashRetentionCutoff: cashRetentionCutoff(db),
  }
}

/** The Salesman-wise Sales Report's top-level table (PHASE11.md section 1) — `getSalesmanBreakdown` over a chosen range. */
export function getSalesmanReport(
  db: Database.Database,
  user: SafeUser,
  range: DateRange,
): SalesmanReportData {
  assertPermission(user.role, 'report:view_all')

  return {
    range,
    generatedAt: nowStamp(db),
    rows: getSalesmanBreakdown(db, user, range),
    cashRetentionCutoff: cashRetentionCutoff(db),
  }
}

/**
 * The Party Outstanding Report (PHASE11.md section 1) — the per-party rows and
 * the shop-wide total, read together.
 *
 * **Together is the whole reason this composer exists.** Acceptance criterion 3
 * is that the list matches the sum `getOutstandingCreditTotal` shows; read as
 * two separate calls, a Payment-In landing between them would split the
 * snapshot and break that match for a reason that has nothing to do with either
 * query being wrong. One call, one instant, one connection.
 *
 * `outstandingTotal` counts positive balances only while `rows` also carries
 * overpaid parties — see `PartyOutstandingRow` and `getPartyOutstandingList`
 * for why those are different questions, and note the screen states the
 * difference rather than letting a reader discover the column doesn't add up to
 * the footer.
 */
export function getPartyOutstandingReport(
  db: Database.Database,
  user: SafeUser,
): PartyOutstandingReportData {
  assertPermission(user.role, 'report:view_all')

  return {
    generatedAt: nowStamp(db),
    rows: getPartyOutstandingList(db, user),
    outstandingTotal: getOutstandingCreditTotal(db, user),
  }
}
