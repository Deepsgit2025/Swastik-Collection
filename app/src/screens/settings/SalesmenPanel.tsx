import { useOwnerGate } from '../../auth/useOwnerGate.tsx'
import { useEffect, useState } from 'react'
import type { SalesmanRow } from '../../types/salesman.ts'
import { INPUT_CLASS } from './formStyles.ts'

/**
 * Add, rename and retire the salesman names offered on the sale screen
 * (2026-08-27), replacing Phase 12's `UserManagementPanel`.
 *
 * That panel created **logins**: a username, a password, a thing that could be
 * signed into. This creates a name and nothing else. There is no password field
 * here because there is nothing to authenticate — what a salesman may reach is
 * no longer a per-person question, it is "everything not behind the Owner
 * password".
 *
 * **Nothing here deletes, and no delete channel exists to call.** Every bill
 * references `salesmen.id`; retiring via `is_active` drops someone out of the
 * sale screen's dropdown while every sale they ever made keeps their name on
 * it. Same rule the login panel had, for the same reason.
 */
export function SalesmenPanel() {
  const { run, gate } = useOwnerGate()
  const [salesmen, setSalesmen] = useState<SalesmanRow[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** Which row's rename box is open, and what is typed in it. */
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [rowError, setRowError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .getSalesmen()
      .then((rows) => {
        if (!cancelled) setSalesmen(rows)
      })
      .catch(() => {
        if (!cancelled) setListError('Could not load the list of salesmen.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** Replaces one row in place — every write returns the updated row, so there is nothing to refetch. */
  function replaceRow(updated: SalesmanRow) {
    setSalesmen((rows) =>
      rows
        .map((row) => (row.id === updated.id ? updated : row))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    )
  }

  function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    const name = newName.trim()
    if (!name || creating) return
    run({ title: 'Add salesman', description: 'Enter the Owner password to continue.' }, () => doCreate(name))
  }

  async function doCreate(name: string) {
    setCreating(true)
    setCreateError(null)
    setNotice(null)
    try {
      const created = await window.api.createSalesman(name)
      setSalesmen((rows) =>
        [...rows, created].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      )
      setNewName('')
      setNotice(`Added ${created.name}.`)
    } catch (err) {
      setCreateError(err instanceof Error && err.message ? err.message : 'Could not add that salesman.')
    } finally {
      setCreating(false)
    }
  }

  function handleRename(id: number) {
    run(
      { title: 'Rename salesman', description: 'Enter the Owner password to continue.' },
      () => doRename(id),
    )
  }

  async function doRename(id: number) {
    const name = renameValue.trim()
    if (!name) return

    setRowError(null)
    try {
      replaceRow(await window.api.renameSalesman(id, name))
      setRenamingId(null)
      setRenameValue('')
      setNotice('Name updated. Past bills now show the corrected name too.')
    } catch (err) {
      setRowError(err instanceof Error && err.message ? err.message : 'Could not rename that salesman.')
    }
  }

  function handleToggleActive(row: SalesmanRow) {
    run(
      { title: 'Change salesman status', description: 'Enter the Owner password to continue.' },
      () => doToggleActive(row),
    )
  }

  async function doToggleActive(row: SalesmanRow) {
    setRowError(null)
    try {
      const updated = await window.api.setSalesmanActive(row.id, row.is_active === 0)
      replaceRow(updated)
      setNotice(
        updated.is_active === 1
          ? `${updated.name} is back in the sale screen's list.`
          : `${updated.name} is retired. Their past sales still show their name.`,
      )
    } catch (err) {
      setRowError(err instanceof Error && err.message ? err.message : 'Could not update that salesman.')
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-800">Salesmen</h2>
      <p className="mt-1 text-sm text-slate-500">
        The names offered in the Salesman box on the sale screen. A salesman has no login — the Owner password is what
        protects the Owner-only screens.
      </p>

      <form onSubmit={handleCreate} className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm text-slate-600">
          Add a salesman
          <input
            type="text"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Full name"
            className={INPUT_CLASS}
          />
        </label>
        <button
          type="submit"
          disabled={creating || newName.trim() === ''}
          className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {creating ? 'Adding…' : 'Add'}
        </button>
      </form>

      {createError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {createError}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {listError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {listError}
        </p>
      )}
      {rowError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {rowError}
        </p>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-slate-500">Loading…</p>
      ) : salesmen.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No salesmen yet. Bills saved before you add one show as “Unassigned”.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
          {salesmen.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 py-3">
              {renamingId === row.id ? (
                <>
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    aria-label={`New name for ${row.name}`}
                    className={`${INPUT_CLASS} flex-1`}
                  />
                  <button
                    type="button"
                    onClick={() => handleRename(row.id)}
                    disabled={renameValue.trim() === ''}
                    className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-300"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingId(null)}
                    className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className={`flex-1 text-sm ${row.is_active ? 'text-slate-800' : 'text-slate-400'}`}>
                    {row.name}
                    {row.is_active === 0 && <span className="ml-2 text-xs text-slate-400">(retired)</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(row.id)
                      setRenameValue(row.name)
                      setRowError(null)
                    }}
                    className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleActive(row)}
                    className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
                  >
                    {row.is_active ? 'Retire' : 'Bring back'}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {gate}
    </section>
  )
}
