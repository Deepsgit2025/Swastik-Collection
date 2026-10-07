import { useEffect, useState } from 'react'
import { ExportCsvButton } from '../../components/ExportCsvButton.tsx'
import { reportFileName, toCsv } from '../../lib/csv.ts'
import { todayIsoDate } from '../../lib/dateRange.ts'
import { formatCurrency, formatDate } from '../../lib/format.ts'
import type { PartyOutstandingReportData } from '../../types/report.ts'

/**
 * Party Outstanding Report (PHASE11.md section 1) — who owes the shop what,
 * right now.
 *
 * **No date-range picker**, deliberately: section 1 calls this a live snapshot,
 * because what is owed is owed regardless of when the sale behind it happened.
 * A Refresh button stands in, matching the dashboard's manual-refresh approach.
 *
 * ### The one thing to understand on this screen
 * The Balance column does **not** add up to the Total Outstanding figure, and
 * that is correct. The total counts positive balances only — the same rule
 * `getOutstandingCreditTotal` and the Owner dashboard use — so a customer
 * sitting on an advance cannot quietly cancel out a different customer's debt.
 * The list additionally shows those advance-holding parties, because acceptance
 * criterion 3 asks for every non-zero balance. Rather than leave a reader to
 * discover the mismatch and doubt the report, the footer says which rows it
 * counted and advance rows are marked where they sit.
 */
export function PartyOutstandingReport() {
  const [data, setData] = useState<PartyOutstandingReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshCount, setRefreshCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    window.api
      .getPartyOutstandingReport()
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the outstanding balances.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [refreshCount])

  const owing = data?.rows.filter((row) => row.balance > 0) ?? []
  const advances = data?.rows.filter((row) => row.balance < 0) ?? []

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setRefreshCount((count) => count + 1)}
            disabled={loading}
            className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          {data != null && (
            <span className="text-sm text-slate-500">As of {formatDate(data.generatedAt)}</span>
          )}
        </div>
        {data != null && (
          <ExportCsvButton
            fileName={reportFileName('party-outstanding', todayIsoDate())}
            disabled={data.rows.length === 0}
            buildCsv={() =>
              toCsv(
                ['Party Outstanding Report', '', ''],
                [
                  ['As of', formatDate(data.generatedAt)],
                  [],
                  ['Party', 'Phone', 'Balance'],
                  // Raw numbers so the column is summable in Excel — and note a
                  // negative balance goes in as `-1200`, not `'-1200`, which is
                  // exactly why `toCsv`'s formula guard skips numeric cells.
                  ...data.rows.map((row) => [row.partyName, row.phone, row.balance]),
                  [],
                  ['Total Outstanding (amounts owed only)', '', data.outstandingTotal],
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
          {data.rows.length === 0 ? (
            <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
              No party is carrying a balance right now.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Party</th>
                    <th className="px-4 py-3 font-medium">Phone</th>
                    <th className="px-4 py-3 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.partyId} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 text-slate-800">{row.partyName}</td>
                      <td className="px-4 py-3 text-slate-600">{row.phone ?? '—'}</td>
                      <td className="px-4 py-3 text-right">
                        {row.balance < 0 ? (
                          // Marked in place rather than hidden or moved to a
                          // separate table: an Owner scanning for who owes money
                          // needs to see immediately that this row is the
                          // opposite, and it is why the column won't sum to the
                          // footer.
                          <span className="font-medium text-emerald-700">
                            {formatCurrency(Math.abs(row.balance))} advance
                          </span>
                        ) : (
                          <span className="font-medium text-slate-800">{formatCurrency(row.balance)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50">
                    <td colSpan={2} className="px-4 py-3 text-right text-slate-600">
                      Total Outstanding
                      <span className="ml-2 text-xs text-slate-500">
                        ({owing.length} {owing.length === 1 ? 'party owes' : 'parties owe'}
                        {advances.length > 0 &&
                          `; ${advances.length} in advance, not counted`}
                        )
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-lg font-semibold text-slate-900">
                      {formatCurrency(data.outstandingTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
