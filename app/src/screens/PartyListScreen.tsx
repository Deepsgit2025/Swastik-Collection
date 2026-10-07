import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppShell } from '../components/AppShell.tsx'
import { PartyFormModal } from '../components/PartyFormModal.tsx'
import { formatCurrency, formatDate } from '../lib/format.ts'
import { useOwnerGate } from '../auth/useOwnerGate.tsx'
import type { PartyDetail, PartyListRow } from '../types/party.ts'

function balanceClass(balance: number): string {
  if (balance > 0) return 'text-red-600'
  if (balance < 0) return 'text-emerald-600'
  return 'text-slate-600'
}

/**
 * Open to everyone since 2026-09-19 (the Owner lock on screens was removed),
 * so Add / Edit / Delete render for whoever is at the counter. What stands in
 * front of them is the Owner password, asked for at the moment it matters:
 * **Delete** asks here, after the confirmation, and **Edit** asks inside
 * `PartyFormModal` when Save is clicked. Adding a party never needed it -
 * `party:create` is open to both roles.
 */
export function PartyListScreen() {
  const navigate = useNavigate()
  const { run, gate } = useOwnerGate()

  const [parties, setParties] = useState<PartyListRow[]>([])
  const [search, setSearch] = useState('')
  const [onlyWithBalanceDue, setOnlyWithBalanceDue] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshCount, setRefreshCount] = useState(0)

  const [formMode, setFormMode] = useState<{ kind: 'create' } | { kind: 'edit'; party: PartyDetail } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PartyListRow | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    window.api
      .getParties({ search, onlyWithBalanceDue })
      .then((rows) => {
        if (!cancelled) setParties(rows)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load parties.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [search, onlyWithBalanceDue, refreshCount])

  function refresh() {
    setRefreshCount((count) => count + 1)
  }

  function handleSaved() {
    setFormMode(null)
    refresh()
  }

  function handleConfirmDelete() {
    if (!deleteTarget) return
    const target = deleteTarget
    // The password is asked for *after* the confirmation, so it is the last
    // thing standing between a click and an irreversible delete.
    run(
      { title: 'Delete party', description: `Deleting ${target.name} cannot be undone. Enter the Owner password to continue.` },
      async () => {
        setDeleting(true)
        setDeleteError(null)
        try {
          await window.api.deleteParty(target.id)
          setDeleteTarget(null)
          refresh()
        } catch {
          setDeleteError('Could not delete party. Please try again.')
        } finally {
          setDeleting(false)
        }
      },
    )
  }

  async function handleEditClick(row: PartyListRow) {
    // The list row doesn't carry `address`, so pull the full record (the
    // ledger query already selects every PartyDetail column) before opening
    // the form pre-filled.
    const result = await window.api.getPartyLedger(row.id)
    if (result) setFormMode({ kind: 'edit', party: result.party })
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-800">Parties</h1>
          <button
            onClick={() => setFormMode({ kind: 'create' })}
            className="rounded bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700"
          >
            + Add Party
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <input
            type="text"
            placeholder="Search by name or phone"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-72 rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
          />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={onlyWithBalanceDue}
              onChange={(event) => setOnlyWithBalanceDue(event.target.checked)}
            />
            Show only parties with balance due
          </label>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Phone</th>
                <th className="px-4 py-2 font-medium">Balance</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {parties.map((party) => (
                <tr
                  key={party.id}
                  onClick={() => navigate(`/parties/${party.id}`)}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-4 py-2 text-slate-800">{party.name}</td>
                  <td className="px-4 py-2 text-slate-600">{party.phone ?? '—'}</td>
                  <td className={`px-4 py-2 font-medium ${balanceClass(party.balance)}`}>
                    {formatCurrency(party.balance)}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{formatDate(party.created_at)}</td>
                  <td className="px-4 py-2">
                    <div className="flex gap-3" onClick={(event) => event.stopPropagation()}>
                      <button
                        onClick={() => handleEditClick(party)}
                        className="text-sm text-slate-600 hover:text-slate-900 hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          setDeleteError(null)
                          setDeleteTarget(party)
                        }}
                        className="text-sm text-red-600 hover:text-red-800 hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && parties.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    No parties found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {formMode && (
        <PartyFormModal
          isOpen
          party={formMode.kind === 'edit' ? formMode.party : undefined}
          onClose={() => setFormMode(null)}
          onSaved={handleSaved}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-lg font-semibold text-slate-800">Delete party?</h2>
            <p className="mt-2 text-sm text-slate-600">
              This permanently deletes <span className="font-medium">{deleteTarget.name}</span>. This cannot be
              undone.
            </p>
            {deleteError && (
              <p role="alert" className="mt-2 text-sm text-red-600">
                {deleteError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {gate}
    </AppShell>
  )
}
