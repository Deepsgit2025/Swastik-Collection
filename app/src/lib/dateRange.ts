/**
 * The shop's own calendar day, and the inclusive `{from, to}` range built on
 * top of it.
 *
 * Lives in its own module rather than inside any one feature's math file
 * because three separate things now need the same answer to "what day is it
 * here?": the Expenses screen's date field (Phase 9), the dashboard's
 * "today" (Phase 10), and Reports' date-range picker (Phase 11). Two
 * hand-written copies of a local-day calculation is exactly the drift this
 * codebase keeps paying for elsewhere.
 */

import type { DateRange } from '../types/report.ts'

/**
 * Today in the shop's own timezone, as 'YYYY-MM-DD'.
 *
 * Built from the local date parts rather than `toISOString().slice(0, 10)`,
 * which is UTC: at 1am IST that would hand back yesterday, and the operator
 * logging the day's first expense would silently file it against the wrong
 * day.
 *
 * Originally written for Phase 9's expense date field (and still re-exported
 * from `expenseMath.ts` for the callers that found it there first).
 */
export function todayIsoDate(now: Date = new Date()): string {
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * The dashboard's "today" as an explicit inclusive range.
 *
 * Every dashboard figure is meant to describe the same window, so the
 * dashboard builds this **once** and passes the same object to all four
 * query functions (`getTodaysSalesSummary`, `getSalesmanBreakdown`,
 * `getOutstandingCreditTotal`'s range-less sibling aside, and Phase 9's
 * `getExpensesTotal`). That matters more than it looks: `getExpensesTotal`
 * treats an omitted range as *all time*, so a dashboard that let any of its
 * calls fall back to a default would quietly show today's sales next to
 * every expense ever logged. One range object, passed explicitly, makes that
 * impossible — and is exactly the call Phase 11 replaces with a real picker.
 */
export function todayRange(now: Date = new Date()): DateRange {
  const today = todayIsoDate(now)
  return { from: today, to: today }
}

/**
 * The Reports picker's default range (PHASE11.md section 1 — "default: this
 * month, but freely adjustable").
 *
 * Month-to-**date**, not month-end: on the 24th, a report headed "1 Aug to 31
 * Aug" describes a window that has not happened yet, and an Owner comparing it
 * against a previous month would be comparing a partial month to a whole one
 * without the header saying so. `to` is today, so the range always describes a
 * window that exists.
 *
 * Built from local date parts for the same reason as `todayIsoDate` — a UTC
 * derivation would roll the month over early on the 1st.
 */
export function thisMonthRange(now: Date = new Date()): DateRange {
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  return { from: `${now.getFullYear()}-${month}-01`, to: todayIsoDate(now) }
}

/**
 * This week so far — Monday to today (client request, 2026-08-27: the Sales
 * module's daily / weekly / monthly windows).
 *
 * Week-to-**date**, not Monday-to-Sunday, for the same reason `thisMonthRange`
 * is month-to-date: a window labelled "23 Aug to 29 Aug" on the 25th describes
 * four days that have not happened, and an Owner comparing it against last week
 * would be comparing a partial week to a whole one with nothing on screen
 * saying so.
 *
 * Monday, not Sunday: `getDay()` returns 0 for Sunday, so the `(day + 6) % 7`
 * shift makes Monday the zero point. Built from local date parts, like every
 * other function here — a UTC derivation would roll the week over early.
 */
export function thisWeekRange(now: Date = new Date()): DateRange {
  const daysSinceMonday = (now.getDay() + 6) % 7
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday)
  return { from: todayIsoDate(monday), to: todayIsoDate(now) }
}

/**
 * Is `value` a well-formed 'YYYY-MM-DD' naming a day that actually exists?
 *
 * The round-trip through `toISOString` is what catches a well-formed but
 * non-existent day like 2026-02-30, which `new Date()` silently rolls forward
 * to March 2nd instead of rejecting. Parsed as UTC on purpose: this only checks
 * that the digits describe a real calendar day, so no timezone shift can move
 * the answer.
 *
 * Lifted out of `validateExpenseDate` (`lib/expenseMath.ts`), which now calls
 * it — Phase 9's expense date, Phase 10's today and Phase 11's picker all need
 * the same answer, and this file already exists because a second hand-written
 * copy of a date calculation is the drift this codebase keeps paying for.
 */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Parses a SQLite `datetime('now')` value — 'YYYY-MM-DD HH:MM:SS', **UTC**,
 * space-separated — into a real `Date`, or null when it isn't one.
 *
 * Every `created_at` in this schema is written by `datetime('now')`, so
 * anything comparing one against wall-clock time has to normalize it first: the
 * space is not an ISO separator and the trailing `Z` is not there to be
 * inferred. `formatDate` (`lib/format.ts`) has done this inline since Phase 3;
 * it now shares this, so a second hand-written copy can't drift — the same move
 * `todayIsoDate` and `isValidIsoDate` already made into this file.
 */
export function parseSqliteUtc(value: string): Date | null {
  const parsed = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Thrown by `assertValidRange` — a distinct type so an IPC handler can report it as a bad request rather than a fault. */
export class InvalidDateRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDateRangeError'
  }
}

/**
 * Rejects a range that a Reports screen could not legitimately have produced.
 *
 * Phase 11's report channels take their range from the renderer, unlike Phase
 * 10's dashboard channels which compute `todayRange()` main-side. The queries
 * are parameterised, so there is no injection to worry about — **the risk here
 * is silence.** `date(col, 'localtime') >= 'garbage'` matches nothing and
 * renders as a truthful-looking "no sales in this range", and an entirely
 * omitted range means *all time* (the trap `getExpensesTotal` documents), which
 * is never what a picker produces. Both are wrong answers that look like right
 * ones, so this fails loudly instead.
 *
 * Both ends are required for the same reason: the dashboard's open-ended
 * `getExpenses`-style filtering is a list-screen convenience, whereas every
 * figure on a report is labelled with the window it measured and that label has
 * to describe something bounded.
 */
export function assertValidRange(range: DateRange): void {
  const from = range?.from?.trim()
  const to = range?.to?.trim()

  if (!from || !to) throw new InvalidDateRangeError('A report needs both a start and an end date.')
  if (!isValidIsoDate(from)) throw new InvalidDateRangeError(`'${from}' is not a real date.`)
  if (!isValidIsoDate(to)) throw new InvalidDateRangeError(`'${to}' is not a real date.`)
  // String comparison is safe on zero-padded 'YYYY-MM-DD': it sorts identically
  // to chronological order, which is also why the SQL clause compares them raw.
  if (from > to) throw new InvalidDateRangeError('The start date is after the end date.')
}
