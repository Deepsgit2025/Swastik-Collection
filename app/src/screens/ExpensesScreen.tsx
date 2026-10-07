import { useEffect, useState } from 'react'
import { AppShell } from '../components/AppShell.tsx'
import { formatCurrency } from '../lib/format.ts'
import {
  todayIsoDate,
  validateExpenseAmount,
  validateExpenseCategory,
  validateExpenseDate,
} from '../lib/expenseMath.ts'
import { EXPENSE_CATEGORIES, type ExpenseCategory, type ExpenseListRow } from '../types/expense.ts'

/**
 * Expenses (PHASE9.md section 1) — the shop-wide expense list plus an
 * add-expense form, both reachable by **either** role.
 *
 * That is the deliberate difference from Parties, where the add/edit controls
 * render only for an Owner: PHASE9.md section 0 records the confirmed decision
 * that a Salesman logs expenses too, reversing an earlier Owner-only
 * assumption. So there is no `isOwner` branch anywhere on this screen.
 *
 * **No edit or delete control exists here for either role** (section 1). The
 * Owner does hold `expense:edit`/`expense:delete` in the PERMISSIONS table,
 * but no screen is being built for them in this phase, so this list is
 * read-plus-append only. That is a deliberate absence, pinned by a test — do
 * not add a row action here without the client asking for one.
 *
 * The list is also **not** filtered to the caller's own entries: acceptance
 * criterion 1 is explicit that a Salesman sees every expense, same shop-wide
 * financial visibility as Phase 4's barcode labels. "Logged by" is shown
 * because both roles can log, so the Owner can tell entries apart.
 */
export function ExpensesScreen() {
  const [expenses, setExpenses] = useState<ExpenseListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [refreshCount, setRefreshCount] = useState(0)

  // Both ends blank by default, so the screen opens on the full list rather
  // than a guessed window the operator has to notice and clear.
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [category, setCategory] = useState<ExpenseCategory>(EXPENSE_CATEGORIES[0])
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayIsoDate)
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<{ amount: number; category: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setListError(null)

    window.api
      .getExpenses({ from: from || null, to: to || null })
      .then((rows) => {
        if (!cancelled) setExpenses(rows)
      })
      .catch(() => {
        if (!cancelled) setListError('Could not load expenses.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [from, to, refreshCount])

  const parsedAmount = amount.trim() === '' ? Number.NaN : Number(amount)
  // The same pure validators `logExpense` runs server-side, so the inline
  // error and the write rejection can never disagree.
  const categoryError = validateExpenseCategory(category)
  const amountError = validateExpenseAmount(parsedAmount)
  const dateError = validateExpenseDate(date)
  const blockingError = categoryError ?? amountError ?? dateError
  const canSubmit = !blockingError && !saving

  async function handleLogExpense() {
    setFormError(null)
    setSaved(null)

    if (blockingError) {
      setFormError(blockingError)
      return
    }

    setSaving(true)
    try {
      const expense = await window.api.logExpense({
        category,
        amount: parsedAmount,
        date,
        note: note.trim() || null,
      })
      setSaved({ amount: expense.amount, category: expense.category })
      // Clear the amount and note but keep the category and date: logging a
      // run of same-day expenses in one sitting is the common case, and
      // resetting the date to today would quietly undo a back-dated entry
      // halfway through.
      setAmount('')
      setNote('')
      setRefreshCount((count) => count + 1)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not log the expense.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Expenses</h1>
          <p className="mt-1 text-sm text-slate-500">
            Shop expenses, newest first. Everyone sees every expense; each entry is recorded against whoever
            logged it.
          </p>
        </div>

        <div className="flex max-w-3xl flex-col gap-4 rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-medium text-slate-800">Add Expense</h2>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Category
              <select
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value as ExpenseCategory)
                  setSaved(null)
                }}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              >
                {EXPENSE_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

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

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Date
              {/* Defaults to today, but editable — an expense is often logged the morning after it was paid. */}
              <input
                type="date"
                value={date}
                onChange={(event) => {
                  setDate(event.target.value)
                  setSaved(null)
                }}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Note (optional)
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. August shop rent"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </label>

          {formError && (
            <p role="alert" className="text-sm text-red-600">
              {formError}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleLogExpense}
              disabled={!canSubmit}
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Add Expense'}
            </button>
            {/*
              The confirmation wins over the hint while it is up. Saving clears
              the amount field, which immediately makes `blockingError` truthy
              again ("Enter an expense amount.") — showing that instead of the
              confirmation would report a successful save as a complaint. The
              hint comes back as soon as the operator touches the form again,
              since every field's onChange clears `saved`.
            */}
            {saved ? (
              <span className="text-sm text-emerald-700">
                Logged {formatCurrency(saved.amount)} — {saved.category}.
              </span>
            ) : (
              !saving && blockingError && <span className="text-sm text-slate-500">{blockingError}</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            From
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            To
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </label>
          {(from || to) && (
            <button
              type="button"
              onClick={() => {
                setFrom('')
                setTo('')
              }}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            >
              Clear dates
            </button>
          )}
        </div>

        {listError && (
          <p role="alert" className="text-sm text-red-600">
            {listError}
          </p>
        )}

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Category</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Note</th>
                {/* Worth showing precisely because both roles can log — it is how the Owner sees who logged what (PHASE9.md section 1). */}
                <th className="px-4 py-2 font-medium">Logged by</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-600">{expense.expense_date}</td>
                  <td className="px-4 py-2 text-slate-800">{expense.category}</td>
                  <td className="px-4 py-2 font-medium text-slate-800">{formatCurrency(expense.amount)}</td>
                  <td className="px-4 py-2 text-slate-600">{expense.note ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-500">{expense.logged_by_name}</td>
                  {/* No Actions column, for either role — see this component's header comment. */}
                </tr>
              ))}
              {!loading && expenses.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    {from || to ? 'No expenses in this date range.' : 'No expenses logged yet.'}
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
