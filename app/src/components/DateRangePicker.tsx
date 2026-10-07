import { thisMonthRange, thisWeekRange, todayIsoDate, todayRange } from '../lib/dateRange.ts'
import type { DateRange } from '../types/report.ts'

/**
 * The From/To picker shared by the two range-scoped reports (PHASE11.md
 * section 1).
 *
 * Dumb by design, like `StatCard` — it holds no state and fetches nothing, so
 * each report owns its own range and its own reload. Styling matches the
 * Expenses screen's existing date filter rather than inventing a second look
 * for the same control.
 *
 * **Both ends are always populated**, unlike Expenses' filter where blank means
 * "no bound". A report labels itself with the window it measured, and an
 * open-ended report has no window to name — the main process rejects a range
 * missing either end for exactly that reason (`assertValidRange`). So there is
 * no "Clear dates" button here; the presets are how you get back to a sensible
 * window.
 */
export interface DateRangePreset {
  label: string
  range: DateRange
}

/**
 * The three windows an Owner actually asks for.
 *
 * **Today is first and exists for a specific reason**: PHASE11.md acceptance
 * criterion 1 is that the Daily Sales Report narrowed to today matches the
 * Phase 10 dashboard exactly. That check should be one click, not a
 * hand-typed pair of dates — the more tedious it is to perform, the less often
 * anyone will notice if the two ever drift apart.
 */
function buildPresets(now: Date): DateRangePreset[] {
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0)
  const month = `${lastMonthEnd.getMonth() + 1}`.padStart(2, '0')

  return [
    { label: 'Today', range: todayRange(now) },
    // Added 2026-08-27 for the Sales module, which the client described as
    // "daily weekly monthly". Today / This Week / This Month is those three,
    // through the picker this codebase already has rather than a second control
    // beside it — and the reports that already used this picker gain a window
    // they had to type by hand before.
    { label: 'This Week', range: thisWeekRange(now) },
    { label: 'This Month', range: thisMonthRange(now) },
    {
      label: 'Last Month',
      // Built from a Date landing on day 0 of this month — i.e. the last day of
      // the previous one — so December rolls the year back without a special
      // case, and a 28/29/30/31-day month ends on its real last day.
      range: {
        from: `${lastMonthEnd.getFullYear()}-${month}-01`,
        to: todayIsoDate(lastMonthEnd),
      },
    },
  ]
}

export function DateRangePicker({
  range,
  onChange,
  disabled = false,
}: {
  range: DateRange
  onChange: (range: DateRange) => void
  disabled?: boolean
}) {
  const presets = buildPresets(new Date())
  const from = range.from ?? ''
  const to = range.to ?? ''
  // Surfaced inline rather than left to the main process to reject: the operator
  // typing these is the one who can fix it, and a round trip to be told "start
  // is after end" is a worse way to learn it than the message appearing as the
  // second date is picked.
  const invalid = from !== '' && to !== '' && from > to

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          From
          <input
            type="date"
            value={from}
            disabled={disabled}
            onChange={(event) => onChange({ ...range, from: event.target.value })}
            className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none disabled:bg-slate-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          To
          <input
            type="date"
            value={to}
            disabled={disabled}
            onChange={(event) => onChange({ ...range, to: event.target.value })}
            className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none disabled:bg-slate-100"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={disabled}
              onClick={() => onChange(preset.range)}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-red-600">
          The start date is after the end date.
        </p>
      )}
    </div>
  )
}

/** Human-readable label for a range — the report's own header line, and the stem of its CSV filename. */
export function formatRangeLabel(range: DateRange): string {
  const from = range.from ?? ''
  const to = range.to ?? ''
  if (from === to) return from
  return `${from} to ${to}`
}
