import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell.tsx'
import { formatCurrency, formatDate } from '../lib/format.ts'
import type { PartyLedgerResult } from '../types/party.ts'

const TYPE_BADGE: Record<string, string> = {
  sale: 'bg-amber-100 text-amber-800',
  payment: 'bg-emerald-100 text-emerald-800',
}

/**
 * Read-only (PHASE3.md section 1): no edit/delete controls on ledger rows —
 * those belong to the Sale/Payment modules in later phases. The one write
 * path added since is the "Record Payment" button below, which only *links*
 * to Phase 8's Payment-In screen with this party pre-selected (PHASE8.md
 * section 1's "accessible inline from a Party Ledger") — the ledger itself
 * still writes nothing.
 */
export function PartyLedgerScreen() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<PartyLedgerResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    const partyId = Number(id)
    if (!Number.isFinite(partyId)) {
      setNotFound(true)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setNotFound(false)

    window.api.getPartyLedger(partyId).then((result) => {
      if (cancelled) return
      if (!result) {
        setNotFound(true)
      } else {
        setData(result)
      }
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [id])

  if (loading) {
    return (
      <AppShell>
        <div className="flex flex-1 items-center justify-center text-slate-500">Loading…</div>
      </AppShell>
    )
  }

  if (notFound || !data) {
    return (
      <AppShell>
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-slate-600">Party not found.</p>
          <button
            onClick={() => navigate('/parties')}
            className="rounded bg-slate-800 px-4 py-2 text-white hover:bg-slate-700"
          >
            Back to Parties
          </button>
        </div>
      </AppShell>
    )
  }

  const { party, entries } = data

  return (
    <AppShell>
      <div className="flex flex-1 flex-col gap-4 p-6">
        <button
          onClick={() => navigate('/parties')}
          className="w-fit text-sm text-slate-500 hover:text-slate-700"
        >
          ← Back to Parties
        </button>

        <div className="flex items-start justify-between rounded-lg border border-slate-200 bg-white p-6">
          <div>
            <h1 className="text-xl font-semibold text-slate-800">{party.name}</h1>
            <p className="mt-1 text-sm text-slate-600">{party.phone ?? 'No phone on file'}</p>
            <p className="mt-4 text-sm text-slate-500">Current balance</p>
            <p className={`text-2xl font-semibold ${party.balance !== 0 ? 'text-red-600' : 'text-slate-800'}`}>
              {formatCurrency(party.balance)}
            </p>
          </div>
          {/* Both roles — recording a payment is allowed for Owner and Salesman alike (PHASE8.md section 4). */}
          <button
            onClick={() => navigate(`/payment-in?partyId=${party.id}`)}
            className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Record Payment
          </button>
        </div>

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 font-medium">Bill amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={`${entry.type}-${entry.id}`} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-500">{formatDate(entry.date)}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${TYPE_BADGE[entry.type]}`}>
                      {entry.type === 'sale' ? 'Sale' : 'Payment'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-700">{entry.description}</td>
                  <td
                    className={`px-4 py-2 font-medium ${entry.type === 'payment' ? 'text-emerald-600' : 'text-slate-800'}`}
                  >
                    {entry.type === 'payment' ? '-' : ''}
                    {formatCurrency(entry.billAmount)}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                    No sales or payments recorded for this party yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  )
}
