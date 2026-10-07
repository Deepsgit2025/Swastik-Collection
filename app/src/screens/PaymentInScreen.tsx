import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell.tsx'
import { formatCurrency } from '../lib/format.ts'
import {
  PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  validatePaymentAmount,
  validatePaymentParty,
} from '../lib/paymentMath.ts'
import type { PaymentInMode, RecordPaymentResult } from '../types/payment.ts'
import type { PartyListRow } from '../types/party.ts'

/**
 * Payment-In (PHASE8.md section 1). Recording money received against a
 * party's outstanding credit balance, independent of any sale.
 *
 * **No WhatsApp gate and no print step anywhere on this screen** — that is
 * the deliberate difference from `NewSaleScreen`, per PHASE8.md section 0 and
 * the permanent rule in CLAUDE.md. "Record Payment" saves and is done; the
 * confirmation panel below shows the new balance and offers nothing to send
 * or print. Don't add either here.
 *
 * Reachable at `/payment-in` for both roles, and from a Party Ledger's
 * "Record Payment" button, which pre-selects that party via `?partyId=`.
 */
export function PaymentInScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const preselectedPartyId = Number(searchParams.get('partyId'))

  const [partySearch, setPartySearch] = useState('')
  const [partyResults, setPartyResults] = useState<PartyListRow[]>([])
  const [selectedParty, setSelectedParty] = useState<PartyListRow | null>(null)
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<PaymentInMode>('cash')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<RecordPaymentResult | null>(null)

  // Pre-selects the party when arriving from a Party Ledger. Keyed on the id
  // alone, so once the operator starts searching for someone else nothing
  // yanks the field back to the party they navigated in with.
  useEffect(() => {
    if (!Number.isInteger(preselectedPartyId) || preselectedPartyId <= 0) return
    let cancelled = false
    window.api
      .getParties()
      .then((rows) => {
        const match = rows.find((row) => row.id === preselectedPartyId)
        if (cancelled || !match) return
        setSelectedParty(match)
        setPartySearch(match.name)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [preselectedPartyId])

  // Search-as-you-type over existing parties. Stops once one is picked —
  // `selectedParty` clears again the moment the field is edited by hand.
  // Same pattern as NewSaleScreen's customer field.
  useEffect(() => {
    let cancelled = false
    const term = partySearch.trim()
    if (!term || selectedParty) {
      setPartyResults([])
      return
    }
    window.api
      .getParties({ search: term })
      .then((rows) => {
        if (!cancelled) setPartyResults(rows)
      })
      .catch(() => {
        if (!cancelled) setPartyResults([])
      })
    return () => {
      cancelled = true
    }
  }, [partySearch, selectedParty])

  function handlePartySearchChange(value: string) {
    setPartySearch(value)
    if (selectedParty) setSelectedParty(null)
    setSaved(null)
  }

  function handlePartySelect(row: PartyListRow) {
    setSelectedParty(row)
    setPartySearch(row.name)
    setPartyResults([])
    setFormError(null)
    setSaved(null)
  }

  const parsedAmount = amount.trim() === '' ? Number.NaN : Number(amount)
  // The same pure validators `recordPayment` runs server-side, so the inline
  // error and the write rejection can never disagree (PHASE8.md acceptance
  // criterion 5 — rejected "before reaching the database").
  const partyError = validatePaymentParty(selectedParty?.id ?? null)
  const amountError = validatePaymentAmount(parsedAmount)
  const blockingError = partyError ?? amountError
  const canSubmit = !blockingError && !saving

  async function handleRecordPayment() {
    setFormError(null)
    setSaved(null)

    if (blockingError) {
      setFormError(blockingError)
      return
    }

    setSaving(true)
    try {
      const result = await window.api.recordPayment({
        partyId: selectedParty!.id,
        amount: parsedAmount,
        mode,
        note: note.trim() || null,
      })
      setSaved(result)
      // Clear the entry fields but keep the party selected, with its new
      // balance — paying off a balance in two goes is common, and making the
      // operator re-search the same party each time would be busywork.
      setAmount('')
      setNote('')
      setSelectedParty({ ...selectedParty!, balance: result.party.balance })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not record the payment.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Payment In</h1>
          <p className="mt-1 text-sm text-slate-500">
            Record money received against a party&apos;s outstanding balance.
          </p>
        </div>

        <div className="flex max-w-xl flex-col gap-4 rounded-lg border border-slate-200 bg-white p-6">
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Party
            <div className="relative">
              <input
                type="text"
                value={partySearch}
                onChange={(event) => handlePartySearchChange(event.target.value)}
                placeholder="Search by name or phone"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
              {!selectedParty && partySearch.trim() !== '' && partyResults.length > 0 && (
                <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded border border-slate-200 bg-white shadow-lg">
                  {partyResults.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => handlePartySelect(row)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                      >
                        <span>{row.name}</span>
                        <span className="text-slate-400">{row.phone ?? '—'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </label>

          {selectedParty ? (
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <span className="text-slate-600">Outstanding balance for {selectedParty.name}: </span>
              <span className={`font-semibold ${selectedParty.balance !== 0 ? 'text-red-600' : 'text-slate-800'}`}>
                {formatCurrency(selectedParty.balance)}
              </span>
            </div>
          ) : (
            <p className="text-sm text-slate-500">A payment always needs a party — search above and pick one.</p>
          )}

          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Amount
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value)
                setSaved(null)
              }}
              placeholder="0.00"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </label>

          <fieldset className="flex flex-col gap-1 text-sm text-slate-600">
            {/* Cash / UPI only — a payment simplifies down to how the money came in, so there is no Credit or Split option here (PHASE8.md section 1). */}
            <legend className="mb-1">Mode</legend>
            <div className="flex gap-2">
              {PAYMENT_MODES.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={mode === option}
                  onClick={() => setMode(option)}
                  className={`rounded border px-4 py-2 text-sm ${
                    mode === option
                      ? 'border-slate-800 bg-slate-800 text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {PAYMENT_MODE_LABELS[option]}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Note (optional)
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. part payment against last week&apos;s bill"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </label>

          {formError && <p className="text-sm text-red-600">{formError}</p>}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleRecordPayment}
              disabled={!canSubmit}
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Recording…' : 'Record Payment'}
            </button>
            {!saving && blockingError && <span className="text-sm text-slate-500">{blockingError}</span>}
          </div>
        </div>

        {saved && (
          /*
            Deliberately the end of the flow: a confirmation and a link to the
            ledger, with no send step and no print button. Payment-In is not
            WhatsApp-gated (PHASE8.md section 0).
          */
          <div className="flex max-w-xl flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-medium text-emerald-800">
              Recorded {formatCurrency(saved.payment.amount)} from {saved.party.name} (
              {PAYMENT_MODE_LABELS[saved.payment.mode]}).
            </p>
            <p className="text-sm text-emerald-700">
              Updated balance: <span className="font-semibold">{formatCurrency(saved.party.balance)}</span>
            </p>
            <button
              type="button"
              onClick={() => navigate(`/parties/${saved.party.id}`)}
              className="w-fit text-sm text-emerald-800 underline hover:text-emerald-900"
            >
              View party ledger
            </button>
          </div>
        )}
      </div>
    </AppShell>
  )
}
