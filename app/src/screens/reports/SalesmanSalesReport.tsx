import { useEffect, useState } from 'react'
import { DateRangePicker, formatRangeLabel } from '../../components/DateRangePicker.tsx'
import { ExportCsvButton } from '../../components/ExportCsvButton.tsx'
import { reportFileName, toCsv } from '../../lib/csv.ts'
import { thisMonthRange } from '../../lib/dateRange.ts'
import { formatCurrency, formatDate } from '../../lib/format.ts'
import { roundMoney } from '../../lib/saleMath.ts'
import type {
  DateRange,
  SalesmanBreakdownRow,
  SalesmanReportData,
  SalesmanSaleRow,
} from '../../types/report.ts'
import { RetentionNote } from '../../components/RetentionNote.tsx'

/**
 * Salesman-wise Sales Report (PHASE11.md section 1) — per-person totals over a
 * range, with the drill-down that is new in this phase.
 *
 * The drill-down is fetched **on click**, not alongside the breakdown: an Owner
 * looking at a month's totals wants six rows, not every individual bill behind
 * them, and pre-loading all of it would make opening the tab proportional to
 * the shop's sales volume for no benefit.
 *
 * The two exports are deliberately separate buttons. One button whose output
 * silently changed depending on which row happened to be open would produce a
 * file whose contents nobody could predict from looking at the screen — so the
 * breakdown exports the breakdown, and the open drill-down exports itself.
 */
export function SalesmanSalesReport() {
  const [range, setRange] = useState<DateRange>(() => thisMonthRange())
  const [data, setData] = useState<SalesmanReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [openRow, setOpenRow] = useState<SalesmanBreakdownRow | null>(null)
  const [drillDown, setDrillDown] = useState<SalesmanSaleRow[] | null>(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError] = useState<string | null>(null)

  const from = range.from ?? ''
  const to = range.to ?? ''
  const rangeUsable = from !== '' && to !== '' && from <= to

  useEffect(() => {
    if (!rangeUsable) return

    let cancelled = false
    setLoading(true)
    setError(null)

    window.api
      .getSalesmanReport({ from, to })
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the salesman-wise report for this range.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [from, to, rangeUsable])

  // An open drill-down describes the *old* range the moment the picker moves,
  // and leaving it on screen under a new set of totals would be a genuinely
  // misleading pair of numbers. Closing is the honest response; the Owner can
  // click the row again.
  useEffect(() => {
    setOpenRow(null)
    setDrillDown(null)
    setDrillError(null)
  }, [from, to])

  async function toggleRow(row: SalesmanBreakdownRow) {
    if (openRow?.salesmanId === row.salesmanId) {
      setOpenRow(null)
      setDrillDown(null)
      return
    }

    setOpenRow(row)
    setDrillDown(null)
    setDrillError(null)
    setDrillLoading(true)
    try {
      // Null is passed through rather than guarded against — it selects the
      // unassigned bucket, which is a row in this table like any other since
      // the salesman field became optional (2026-08-27).
      setDrillDown(await window.api.getSalesmanSales(row.salesmanId, { from, to }))
    } catch {
      setDrillError('Could not load this salesman’s sales.')
    } finally {
      setDrillLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <DateRangePicker range={range} onChange={setRange} disabled={loading} />
        {data != null && (
          <ExportCsvButton
            fileName={reportFileName('salesman-sales', formatRangeLabel(data.range))}
            disabled={data.rows.length === 0}
            buildCsv={() =>
              toCsv(
                ['Salesman-wise Sales Report', '', '', '', '', ''],
                [
                  ['Range', formatRangeLabel(data.range)],
                  ['Generated', formatDate(data.generatedAt)],
                  [],
                  ['Salesman', 'Sales', 'Total', 'Cash', 'UPI', 'Credit'],
                  ...data.rows.map((row) => [
                    row.salesmanName,
                    row.saleCount,
                    row.total,
                    row.cashTotal,
                    row.upiTotal,
                    row.creditTotal,
                  ]),
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

      {data != null && (
        <>
          <p className="text-sm text-slate-500">
            {formatRangeLabel(data.range)} · Generated {formatDate(data.generatedAt)}
          </p>

          <RetentionNote range={data.range} cashRetentionCutoff={data.cashRetentionCutoff} />

          {data.rows.length === 0 ? (
            <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
              No sales recorded in this range.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Salesman</th>
                    <th className="px-4 py-3 text-right font-medium">Sales</th>
                    <th className="px-4 py-3 text-right font-medium">Total</th>
                    <th className="px-4 py-3 text-right font-medium">Cash</th>
                    <th className="px-4 py-3 text-right font-medium">UPI</th>
                    <th className="px-4 py-3 text-right font-medium">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const isOpen = openRow?.salesmanId === row.salesmanId
                    return [
                      <tr
                        key={row.salesmanId ?? 'unassigned'}
                        className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                      >
                        <td className="px-4 py-3 text-slate-800">
                          {/*
                            The clickable control is a real <button>, not an
                            onClick on the <tr>: a row is not focusable or
                            operable from the keyboard, and this is the only way
                            into the drill-down.
                          */}
                          <button
                            type="button"
                            onClick={() => toggleRow(row)}
                            aria-expanded={isOpen}
                            className="text-left font-medium text-slate-800 hover:text-slate-950"
                          >
                            {isOpen ? '▾' : '▸'} {row.salesmanName}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right text-slate-600">{row.saleCount}</td>
                        <td className="px-4 py-3 text-right font-medium text-slate-800">
                          {formatCurrency(row.total)}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-600">{formatCurrency(row.cashTotal)}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{formatCurrency(row.upiTotal)}</td>
                        <td className="px-4 py-3 text-right text-slate-600">
                          {formatCurrency(row.creditTotal)}
                        </td>
                      </tr>,
                      isOpen && (
                        <tr key={`${row.salesmanId ?? 'unassigned'}-detail`} className="border-b border-slate-100">
                          <td colSpan={6} className="bg-slate-50 px-4 py-4">
                            <DrillDown
                              salesmanName={row.salesmanName}
                              rangeLabel={formatRangeLabel(data.range)}
                              rows={drillDown}
                              loading={drillLoading}
                              error={drillError}
                            />
                          </td>
                        </tr>
                      ),
                    ]
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * One salesman's individual sales in the range (PHASE11.md section 1 — "item
 * count, total, payment mode, timestamp").
 *
 * The total under the table is the sum of the rows shown, and it should equal
 * that person's Total in the table above — acceptance criterion 2. It is
 * rendered rather than left implicit precisely so that equality is checkable by
 * eye without adding up a column of bills.
 */
function DrillDown({
  salesmanName,
  rangeLabel,
  rows,
  loading,
  error,
}: {
  salesmanName: string
  rangeLabel: string
  rows: SalesmanSaleRow[] | null
  loading: boolean
  error: string | null
}) {
  if (loading) return <p className="text-sm text-slate-500">Loading sales…</p>
  if (error != null)
    return (
      <p role="alert" className="text-sm text-red-600">
        {error}
      </p>
    )
  if (rows == null) return null
  if (rows.length === 0) return <p className="text-sm text-slate-500">No individual sales in this range.</p>

  // Through `roundMoney` for the same reason every total in the query layer is:
  // each `grandTotal` is already rounded to paise, but adding a few dozen of
  // them reintroduces 0.1+0.2 drift — and this figure exists specifically to be
  // compared against the breakdown row above it, so a trailing 0.0000001 here
  // would read as the very discrepancy criterion 2 is checking for.
  const total = roundMoney(rows.reduce((sum, row) => sum + row.grandTotal, 0))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-700">
          {salesmanName} — {rows.length} {rows.length === 1 ? 'sale' : 'sales'}
        </h3>
        <ExportCsvButton
          fileName={reportFileName(`sales-${salesmanName}`, rangeLabel)}
          buildCsv={() =>
            toCsv(
              [`Sales by ${salesmanName}`, '', '', '', '', '', '', ''],
              [
                ['Range', rangeLabel],
                [],
                ['Sale ID', 'Date', 'Customer', 'Items', 'Payment Mode', 'Total', 'Cash', 'UPI', 'Credit'],
                ...rows.map((row) => [
                  row.saleId,
                  formatDate(row.createdAt),
                  row.partyName ?? 'Walk-in Customer',
                  row.itemCount,
                  row.paymentMode,
                  row.grandTotal,
                  row.cashAmount,
                  row.upiAmount,
                  row.creditAmount,
                ]),
              ],
            )
          }
        />
      </div>
      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 text-right font-medium">Items</th>
              <th className="px-3 py-2 font-medium">Payment</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.saleId} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2 text-slate-600">{formatDate(row.createdAt)}</td>
                {/* A cash sale has no party — `sales.party_id` is nullable, and a
                    walk-in is the ordinary case. Matches NewSaleScreen's wording. */}
                <td className="px-3 py-2 text-slate-600">{row.partyName ?? 'Walk-in Customer'}</td>
                <td className="px-3 py-2 text-right text-slate-600">{row.itemCount}</td>
                <td className="px-3 py-2 capitalize text-slate-600">{row.paymentMode}</td>
                <td className="px-3 py-2 text-right font-medium text-slate-800">
                  {formatCurrency(row.grandTotal)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200">
              <td colSpan={4} className="px-3 py-2 text-right text-slate-500">
                Total
              </td>
              <td className="px-3 py-2 text-right font-semibold text-slate-900">
                {formatCurrency(total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
