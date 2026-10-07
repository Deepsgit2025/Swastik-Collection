// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { todayIsoDate, validateExpenseDate } from './expenseMath.ts'

/**
 * The amount and category validators are exercised through `logExpense` in
 * `src/db/expenses.test.ts`, where they actually gate a write. These two carry
 * logic that is easy to get subtly wrong on its own.
 */
describe('todayIsoDate', () => {
  it('formats a date as YYYY-MM-DD with padded month and day', () => {
    expect(todayIsoDate(new Date(2026, 0, 5, 14, 30))).toBe('2026-01-05')
    expect(todayIsoDate(new Date(2026, 11, 31, 9, 0))).toBe('2026-12-31')
  })

  /**
   * The reason this is not `toISOString().slice(0, 10)`: local dates ahead of
   * UTC roll over first, so just after midnight IST the UTC date is still
   * yesterday, and the day's first expense would be filed against the wrong
   * day. Constructed with local-time parts, so this holds whatever timezone
   * the machine runs in.
   */
  it('uses the local day, not the UTC one, just after local midnight', () => {
    const justAfterLocalMidnight = new Date(2026, 7, 24, 0, 30)

    expect(todayIsoDate(justAfterLocalMidnight)).toBe('2026-08-24')
  })

  it('defaults to now when called with no argument', () => {
    expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('validateExpenseDate', () => {
  it('accepts a real day', () => {
    expect(validateExpenseDate('2026-08-24')).toBeNull()
  })

  it('accepts a leap day in a leap year but rejects it in a common one', () => {
    expect(validateExpenseDate('2028-02-29')).toBeNull()
    expect(validateExpenseDate('2026-02-29')).toMatch(/not a real date/i)
  })

  it.each(['', '24-08-2026', '2026-8-24', '2026/08/24', 'today'])(
    'rejects the malformed date %s',
    (value) => {
      expect(validateExpenseDate(value)).toMatch(/expense date/i)
    },
  )

  it('allows a future date — paying rent or a supplier in advance is real', () => {
    expect(validateExpenseDate('2099-01-01')).toBeNull()
  })
})
