import { useEffect, useMemo, useState } from 'react'
import { AppShell } from '../components/AppShell.tsx'
import { DateRangePicker, formatRangeLabel } from '../components/DateRangePicker.tsx'
import { ExportCsvButton } from '../components/ExportCsvButton.tsx'
import { reportFileName, toCsv } from '../lib/csv.ts'
import { todayRange } from '../lib/dateRange.ts'
import { formatCurrency, formatDate } from '../lib/format.ts'
import { roundMoney } from '../lib/saleMath.ts'
import type { DateRange, SalesLedgerRow, SalesmanBreakdownRow } from '../types/report.ts'

/**
 * `/sales` — the Sales module (client request, 2026-08-27: "it shows customer
 * name, amount and salesman … we can sort by salesman, and daily weekly
 * monthly to know which salesman sold the most").
 *
 * Two halves, both over the **same** range and read in the same effect:
 *
 *  - a per-salesman totals strip, which is the "who sold the most" answer; and
 *  - the bill list, which is what those totals are made of.
 *
 * They come from two channels (`getSalesLedger` and `getSalesmanReport`) but
 * both filter through `buildLocalDayRangeClause` in `src/db/reports.ts`, so the
 * strip is the sum of the table by construction rather than by coincidence.
 * Fetched together and swapped in together, so the screen never shows a total
 * from one window above rows from another.
 *
 * **Not a fourth Reports tab, deliberately** — the client asked for it in the
 * sidebar by name, and it answers a different question from Reports'
 * Salesman-wise tab: that one is the export-and-drill-down view, this is the
 * glance. The overlap is real and intended.
 *
 * Open to the counter since 2026-09-19 (it only reads); `report:view_all`
 * inside both composers is still asserted, and now allows both roles.
 */

type SortKey = 'date' | 'customer' | 'salesman' | 'amount'
type SortDirection = 'asc' | 'desc'

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'date', label: 'Date' },
  { key: 'customer', label: 'Customer' },
  { key: 'salesman', label: 'Salesman' },
  { key: 'amount', label: 'Amount', numeric: true },
]

/** Matches NewSaleScreen's wording — `sales.party_id` is nullable and a walk-in is the ordinary case, not an anomaly. */
const WALK_IN = 'Walk-in Customer'

export function SalesScreen() {
  // Today by default rather than this month: "who sold the most" is usually a
  // question about the shift that is happening, and the presets put the week
  // and the month one click away.
  const [range, setRange] = useState<DateRange>(() => todayRange())
  const [rows, setRows] = useState<SalesLedgerRow[] | null>(null)
  const [breakdown, setBreakdown] = useState<SalesmanBreakdownRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const from = range.from ?? ''
  const to = range.to ?? ''
  const rangeUsable = from !== '' && to !== '' && from <= to

  useEffect(() => {
    if (!rangeUsable) return

    let cancelled = false
    setLoading(true)
    setError(null)

    // One `Promise.all` so both halves swap in together — fetched in sequence
    // they would briefly paint new totals above the previous range's rows.
    Promise.all([window.api.getSalesLedger({ from, to }), window.api.getSalesmanReport({ from, to })])
      .then(([ledger, report]) => {
        if (cancelled) return
        setRows(ledger)
        setBreakdown(report.rows)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load sales for this range.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [from, to, rangeUsable])

  /**
   * Sorted client-side. The range is bounded main-side by `assertValidRange`,
   * so this is at most a month of one shop's bills — re-querying on every
   * header click would be slower than sorting an array that is already here,
   * and would flash a loading state to reorder rows the screen already holds.
   */
  const sortedRows = useMemo(() => {
    if (!rows) return null
    const factor = sortDirection === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case 'amount':
          return (a.grandTotal - b.grandTotal) * factor
        case 'customer':
          return (
            (a.partyName ?? WALK_IN).localeCompare(b.partyName ?? WALK_IN, undefined, {
              sensitivity: 'base',
            }) * factor
          )
        case 'salesman':
          // Ties broken by time, so sorting by salesman both groups each
          // person's bills and leaves them readable within the group, rather
          // than in whatever order the equal-key comparison happened to leave.
          return (
            (a.salesmanName.localeCompare(b.salesmanName, undefined, { sensitivity: 'base' }) ||
              a.createdAt.localeCompare(b.createdAt)) * factor
          )
        default:
          return (a.createdAt.localeCompare(b.createdAt) || a.saleId - b.saleId) * factor
      }
    })
  }, [rows, sortKey, sortDirection])

  // Through `roundMoney` for the reason every total in the query layer is: each
  // `grandTotal` is already rounded to paise, but adding a few dozen of them
  // reintroduces 0.1 + 0.2 drift — and this figure exists to be checked against
  // the per-salesman strip above it by eye.
  const total = useMemo(
    () => (rows ? roundMoney(rows.reduce((sum, row) => sum + row.grandTotal, 0)) : 0),
    [rows],
  )

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    // Money and dates read best biggest/newest first, names A-Z. Guessing right
    // on the first click saves a second one every time.
    setSortDirection(key === 'amount' || key === 'date' ? 'desc' : 'asc')
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col gap-6 overflow-auto p-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Sales</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every bill in the range, and who sold it. Use Today / This Week / This Month to compare periods.
          </p>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <DateRangePicker range={range} onChange={setRange} disabled={loading} />
          {sortedRows != null && (
            <ExportCsvButton
              fileName={reportFileName('sales', formatRangeLabel(range))}
              disabled={sortedRows.length === 0}
              buildCsv={() =>
                toCsv(
                  ['Sales', '', '', '', '', ''],
                  [
                    ['Range', formatRangeLabel(range)],
                    [],
                    ['Bill No.', 'Date', 'Customer', 'Salesman', 'Payment Mode', 'Amount'],
                    // Exports what is on screen, in the order it is on screen —
                    // a file that silently re-sorted would not match the table
                    // the Owner was looking at when they clicked.
                    ...sortedRows.map((row) => [
                      row.saleId,
                      formatDate(row.createdAt),
                      row.partyName ?? WALK_IN,
                      row.salesmanName,
                      row.paymentMode,
                      row.grandTotal,
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

        {breakdown != null && breakdown.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-slate-700">Who sold the most</h2>
            <div className="flex flex-wrap gap-3">
              {/* Already ordered biggest-first by `getSalesmanBreakdown` — no
                  second sort here, so the two screens that render this list
                  cannot disagree about the ranking. */}
              {breakdown.map((row) => (
                <div
                  key={row.salesmanId ?? 'unassigned'}
                  className="min-w-[10rem] flex-1 rounded-lg border border-slate-200 bg-white px-4 py-3"
                >
                  <p className="text-sm font-medium text-slate-800">{row.salesmanName}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{formatCurrency(row.total)}</p>
                  <p className="text-xs text-slate-500">
                    {row.saleCount} {row.saleCount === 1 ? 'bill' : 'bills'}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {sortedRows != null &&
          (sortedRows.length === 0 ? (
            <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
              No sales recorded in this range.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Bill No.</th>
                    {COLUMNS.map((column) => (
                      <th
                        key={column.key}
                        className={`px-4 py-3 font-medium ${column.numeric ? 'text-right' : ''}`}
                        aria-sort={
                          sortKey === column.key
                            ? sortDirection === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        {/* A real <button>, not an onClick on the <th>: a
                            header cell is not focusable or operable from the
                            keyboard, and sorting is the whole point here. */}
                        <button
                          type="button"
                          onClick={() => toggleSort(column.key)}
                          className="font-medium text-slate-500 hover:text-slate-800"
                        >
                          {column.label}
                          {sortKey === column.key && (sortDirection === 'asc' ? ' ▲' : ' ▼')}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr key={row.saleId} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 text-slate-500">#{row.saleId}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(row.createdAt)}</td>
                      <td className="px-4 py-3 text-slate-600">{row.partyName ?? WALK_IN}</td>
                      {/* Greyed when unassigned, so "Unassigned" reads as a
                          state of the bill rather than as somebody's name. */}
                      <td className={`px-4 py-3 ${row.salesmanId == null ? 'text-slate-400' : 'text-slate-800'}`}>
                        {row.salesmanName}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-800">
                        {formatCurrency(row.grandTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200">
                    <td colSpan={4} className="px-4 py-3 text-right text-slate-500">
                      {sortedRows.length} {sortedRows.length === 1 ? 'bill' : 'bills'} · Total
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900">
                      {formatCurrency(total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ))}
      </div>
    </AppShell>
  )
}
