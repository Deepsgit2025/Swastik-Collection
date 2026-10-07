import { useEffect, useState } from 'react'
import { QuickLinks, type QuickLink } from '../components/QuickLinks.tsx'
import { StatCard } from '../components/StatCard.tsx'
import { formatCurrency, formatDate } from '../lib/format.ts'
import type { OwnerDashboardData } from '../types/report.ts'

/**
 * The Owner's view of today (PHASE10.md section 1) — the whole shop at a
 * glance.
 *
 * Every figure comes from a single `getOwnerDashboard()` call, so they all
 * describe the same window; see the composer in `src/db/reports.ts` for why
 * that is assembled main-side rather than as four calls from here.
 *
 * Read-only. Nothing on this screen writes.
 */
const OWNER_QUICK_LINKS: QuickLink[] = [
  { label: 'New Sale', to: '/sale/new' },
  { label: 'Payment In', to: '/payment-in' },
  { label: 'Parties', to: '/parties' },
  { label: 'Expenses', to: '/expenses' },
  // Live since Phase 11 — was an inert tile while `/reports` didn't exist, so
  // an enabled link wouldn't bounce off App.tsx's catch-all and read as a bug.
  { label: 'Reports', to: '/reports' },
]

export function OwnerDashboard() {
  const [data, setData] = useState<OwnerDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshCount, setRefreshCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    window.api
      .getOwnerDashboard()
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch(() => {
        if (!cancelled) setError("Could not load today's numbers.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [refreshCount])

  const summary = data?.summary

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Today at a Glance</h1>
          <p className="mt-1 text-sm text-slate-500">
            {/*
              The stamp is the moment the numbers were read, not the moment the
              page was opened — a dashboard left up all afternoon should not
              look current when it isn't. It comes from the main process, off
              the same clock that stamps every sale.
            */}
            {data ? `Updated ${formatDate(data.generatedAt)}` : 'Loading…'}
          </p>
        </div>
        <button
          onClick={() => setRefreshCount((count) => count + 1)}
          disabled={loading}
          className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error != null && (
        <p className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {summary != null && data != null && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard
              label="Today's Sales"
              value={formatCurrency(summary.salesTotal)}
              detail={`${summary.saleCount} ${summary.saleCount === 1 ? 'sale' : 'sales'} billed today`}
              emphasis
            />
            {/*
              Cash and UPI each show both halves underneath (PHASE10.md
              acceptance criterion 4): the part that arrived with today's sales
              and the part that arrived as Payment-In against older credit
              bills. Splitting them out is what lets the figure be checked
              against the tables by hand, and makes it obvious that a credit
              sale's credit_amount is in neither.
            */}
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
              label="Credit Given Today"
              value={formatCurrency(summary.creditIssued)}
              detail="Billed today, not yet collected — counts as money in only when it is paid."
            />
            <StatCard
              label="Outstanding Credit"
              value={formatCurrency(data.outstandingCredit)}
              // Deliberately not "today": section 1 calls this out as a live
              // snapshot of what every party owes right now, whenever the sale
              // behind it happened.
              detail="Total owed by all parties, as of now"
            />
            <StatCard
              label="Today's Expenses"
              value={formatCurrency(data.expenseTotal)}
              detail="All categories, logged by either role"
            />
          </div>

          <section className="flex flex-col gap-3">
            <h2 className="text-base font-medium text-slate-800">Salesman-wise Sales</h2>
            {data.salesmanBreakdown.length === 0 ? (
              <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
                No sales recorded yet today.
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
                    {data.salesmanBreakdown.map((row) => (
                      <tr key={row.salesmanId ?? 'unassigned'} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3 text-slate-800">{row.salesmanName}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{row.saleCount}</td>
                        <td className="px-4 py-3 text-right font-medium text-slate-800">
                          {formatCurrency(row.total)}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-600">{formatCurrency(row.cashTotal)}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{formatCurrency(row.upiTotal)}</td>
                        <td className="px-4 py-3 text-right text-slate-600">
                          {formatCurrency(row.creditTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium text-slate-800">Quick Links</h2>
        <QuickLinks links={OWNER_QUICK_LINKS} />
      </section>
    </div>
  )
}
