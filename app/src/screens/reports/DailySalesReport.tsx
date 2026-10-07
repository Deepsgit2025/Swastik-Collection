import { useEffect, useState } from 'react'
import { DateRangePicker, formatRangeLabel } from '../../components/DateRangePicker.tsx'
import { ExportCsvButton } from '../../components/ExportCsvButton.tsx'
import { StatCard } from '../../components/StatCard.tsx'
import { reportFileName, toCsv } from '../../lib/csv.ts'
import { thisMonthRange } from '../../lib/dateRange.ts'
import { formatCurrency, formatDate } from '../../lib/format.ts'
import type { DailySalesReportData, DateRange } from '../../types/report.ts'
import { RetentionNote } from '../../components/RetentionNote.tsx'

/**
 * Daily Sales Report (PHASE11.md section 1) — the Owner dashboard's figures
 * over any range instead of today.
 *
 * The cards mirror the Owner dashboard's deliberately, including the two-part
 * `detail` on Cash and UPI. That is not just visual consistency: acceptance
 * criterion 1 asks whoever verifies this to narrow the range to today and check
 * the numbers against the dashboard, and that comparison is far easier when the
 * two screens present the same figures in the same order with the same
 * breakdown underneath. The **Today** preset makes narrowing a single click.
 *
 * Owns its own fetch — `ReportsScreen` renders tabs and nothing else, the same
 * discipline `DashboardScreen` follows.
 */

/** Every figure the screen shows, in display order — so the CSV can't drift from the cards by construction. */
function summaryRows(data: DailySalesReportData): [string, number][] {
  const s = data.summary
  return [
    ['Total Sales', s.salesTotal],
    ['Cash Collected', s.cashCollected],
    ['Cash from Sales', s.cashFromSales],
    ['Cash from Payment-In', s.cashFromPayments],
    ['UPI Collected', s.upiCollected],
    ['UPI from Sales', s.upiFromSales],
    ['UPI from Payment-In', s.upiFromPayments],
    ['Total Collected', s.totalCollected],
    ['Credit Issued', s.creditIssued],
    ['Credit Collected', s.creditCollected],
  ]
}

export function DailySalesReport() {
  // "This month, but freely adjustable" (section 1). Month-to-date rather than
  // month-end — see `thisMonthRange`.
  const [range, setRange] = useState<DateRange>(() => thisMonthRange())
  const [data, setData] = useState<DailySalesReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const from = range.from ?? ''
  const to = range.to ?? ''
  const rangeUsable = from !== '' && to !== '' && from <= to

  useEffect(() => {
    // Nothing is fetched for a range the main process would reject anyway; the
    // picker already says why inline. Mid-edit a `type="date"` input goes
    // briefly empty, so firing on every keystroke would mean a stream of
    // rejected calls and a flickering error.
    if (!rangeUsable) return

    let cancelled = false
    setLoading(true)
    setError(null)

    window.api
      .getDailySalesReport({ from, to })
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the sales report for this range.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [from, to, rangeUsable])

  const summary = data?.summary

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <DateRangePicker range={range} onChange={setRange} disabled={loading} />
        {data != null && (
          <ExportCsvButton
            fileName={reportFileName('daily-sales', formatRangeLabel(data.range))}
            buildCsv={() =>
              toCsv(
                ['Daily Sales Report', ''],
                [
                  ['Range', formatRangeLabel(data.range)],
                  ['Generated', formatDate(data.generatedAt)],
                  ['Sales Count', data.summary.saleCount],
                  [],
                  ['Figure', 'Amount'],
                  // Raw numbers, not `formatCurrency` — the same values the
                  // cards show, unformatted so the accountant can sum the
                  // column instead of retyping it.
                  ...summaryRows(data),
                ],
              )
            }
          />
        )}
      </div>

      {error != null && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {summary != null && data != null && (
        <>
          <p className="text-sm text-slate-500">
            {/* The range echoed from the payload, not from local state — the screen
                labels the window the numbers were actually measured over, which can
                differ from the picker for as long as a fetch is in flight. */}
            {formatRangeLabel(data.range)} · {data.summary.saleCount}{' '}
            {data.summary.saleCount === 1 ? 'sale' : 'sales'} · Generated{' '}
            {formatDate(data.generatedAt)}
          </p>

          <RetentionNote range={data.range} cashRetentionCutoff={data.cashRetentionCutoff} />

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard
              label="Total Sales"
              value={formatCurrency(summary.salesTotal)}
              detail="Billed in this range, however it was paid"
              emphasis
            />
            <StatCard
              label="Cash Collected"
              value={formatCurrency(summary.cashCollected)}
              detail={`${formatCurrency(summary.cashFromSales)} from sales + ${formatCurrency(
                summary.cashFromPayments,
              )} from Payment-In`}
            />
            <StatCard
              label="UPI Collected"
              value={formatCurrency(summary.upiCollected)}
              detail={`${formatCurrency(summary.upiFromSales)} from sales + ${formatCurrency(
                summary.upiFromPayments,
              )} from Payment-In`}
            />
            <StatCard
              label="Credit Issued"
              value={formatCurrency(summary.creditIssued)}
              detail="New credit billed in this range — not money that arrived"
            />
            <StatCard
              label="Credit Collected"
              value={formatCurrency(summary.creditCollected)}
              detail="Payment-In against credit, whenever the sale behind it happened"
            />
            <StatCard
              label="Total Collected"
              value={formatCurrency(summary.totalCollected)}
              detail="Every rupee that actually arrived in this range"
            />
          </div>
        </>
      )}
    </div>
  )
}
