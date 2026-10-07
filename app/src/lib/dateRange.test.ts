import { describe, expect, it } from 'vitest'
import {
  InvalidDateRangeError,
  assertValidRange,
  isValidIsoDate,
  thisMonthRange,
  todayRange,
} from './dateRange.ts'

/**
 * `todayIsoDate`'s own local-vs-UTC behaviour is already pinned by
 * `expenseMath.test.ts` (where it lived until Phase 10) — these cover what
 * Phase 11 added on top of it.
 */
describe('thisMonthRange', () => {
  it('runs from the first of the month to today, not to the end of the month', () => {
    // Mid-month: a report headed "to 31 Aug" on the 24th would describe a
    // window that hasn't happened, and would silently compare a partial month
    // against a whole one.
    expect(thisMonthRange(new Date(2026, 7, 24))).toEqual({ from: '2026-08-01', to: '2026-08-24' })
  })

  it('zero-pads a single-digit month', () => {
    expect(thisMonthRange(new Date(2026, 0, 9))).toEqual({ from: '2026-01-01', to: '2026-01-09' })
  })

  it('is a single day on the 1st', () => {
    expect(thisMonthRange(new Date(2026, 2, 1))).toEqual({ from: '2026-03-01', to: '2026-03-01' })
  })

  it('uses local date parts, so it does not roll the month early just after midnight', () => {
    // 00:30 on the 1st: `toISOString()` would give the previous month in IST,
    // producing a range whose `from` is a month behind its `to`.
    const justAfterMidnight = new Date(2026, 8, 1, 0, 30)
    expect(thisMonthRange(justAfterMidnight)).toEqual({ from: '2026-09-01', to: '2026-09-01' })
  })
})

describe('isValidIsoDate', () => {
  it('accepts a real day', () => {
    expect(isValidIsoDate('2026-08-24')).toBe(true)
  })

  it('accepts a leap day in a leap year', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true)
  })

  it('rejects a well-formed day that does not exist', () => {
    // The case the round-trip through toISOString exists for — `new Date()`
    // silently rolls these forward instead of rejecting them.
    expect(isValidIsoDate('2026-02-30')).toBe(false)
    expect(isValidIsoDate('2026-02-29')).toBe(false)
    expect(isValidIsoDate('2026-13-01')).toBe(false)
  })

  it.each(['', '2026-8-24', '24-08-2026', 'garbage', '2026-08-24T00:00:00'])(
    'rejects the malformed value %j',
    (value) => {
      expect(isValidIsoDate(value)).toBe(false)
    },
  )
})

describe('assertValidRange', () => {
  it('accepts a well-formed range', () => {
    expect(() => assertValidRange({ from: '2026-08-01', to: '2026-08-24' })).not.toThrow()
  })

  it('accepts a single-day range', () => {
    expect(() => assertValidRange(todayRange())).not.toThrow()
  })

  it('accepts the picker default', () => {
    expect(() => assertValidRange(thisMonthRange())).not.toThrow()
  })

  it.each([
    ['both ends missing', {}],
    ['no start', { to: '2026-08-24' }],
    ['no end', { from: '2026-08-01' }],
    ['a blank start', { from: '   ', to: '2026-08-24' }],
    ['a null end', { from: '2026-08-01', to: null }],
  ])('rejects %s', (_label, range) => {
    // An omitted range means *all time* to `getExpensesTotal`, and a report
    // labels itself with the window it measured — an open-ended one has no
    // window to name.
    expect(() => assertValidRange(range)).toThrow(InvalidDateRangeError)
  })

  it('rejects a malformed end rather than letting it match no rows', () => {
    // This is the whole reason validation exists here: the SQL is
    // parameterised so there is nothing to inject, but `date(col,'localtime')
    // >= 'garbage'` matches nothing and renders as a plausible "no sales".
    expect(() => assertValidRange({ from: 'garbage', to: '2026-08-24' })).toThrow(
      InvalidDateRangeError,
    )
    expect(() => assertValidRange({ from: '2026-08-01', to: 'garbage' })).toThrow(
      InvalidDateRangeError,
    )
  })

  it('rejects a day that does not exist', () => {
    expect(() => assertValidRange({ from: '2026-02-30', to: '2026-03-05' })).toThrow(
      InvalidDateRangeError,
    )
  })

  it('rejects a start after its end', () => {
    expect(() => assertValidRange({ from: '2026-08-25', to: '2026-08-01' })).toThrow(
      /start date is after/i,
    )
  })

  it('trims before comparing, so surrounding whitespace is not a rejection', () => {
    expect(() => assertValidRange({ from: ' 2026-08-01 ', to: ' 2026-08-24 ' })).not.toThrow()
  })
})
