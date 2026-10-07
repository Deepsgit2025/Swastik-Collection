import { useState } from 'react'
import type { FormEvent } from 'react'
import { useOwnerGate } from '../auth/useOwnerGate.tsx'
import type { PartyDetail } from '../types/party.ts'

interface PartyFormModalProps {
  isOpen: boolean
  /** Present for edit, absent for create — determines both the submit call and the field defaults. */
  party?: PartyDetail
  onClose: () => void
  onSaved: (party: PartyDetail) => void
}

/**
 * The full party form: name, phone, address, and (create-only) opening balance
 * (PHASE3.md section 1).
 *
 * Open to the counter since 2026-09-19, when the Owner lock on screens was
 * removed - but **saving an edit asks for the Owner password**, at the moment
 * Save is clicked (`useOwnerGate`). The form opens freely and can be filled in;
 * nothing changes until the password is given. Adding a new party never needed
 * it (`party:create` is open to both roles), so it still does not.
 */
export function PartyFormModal({ isOpen, party, onClose, onSaved }: PartyFormModalProps) {
  const isEdit = party != null

  const [name, setName] = useState(party?.name ?? '')
  const [phone, setPhone] = useState(party?.phone ?? '')
  const [address, setAddress] = useState(party?.address ?? '')
  const [openingBalance, setOpeningBalance] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const { run, gate } = useOwnerGate()

  if (!isOpen) return null

  function reset() {
    setName('')
    setPhone('')
    setAddress('')
    setOpeningBalance('')
    setError(null)
    setSaving(false)
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Name is required.')
      return
    }

    async function save() {
      setSaving(true)
      try {
        const saved =
          isEdit && party
            ? await window.api.updateParty(party.id, {
                name: name.trim(),
                phone: phone.trim() || null,
                address: address.trim() || null,
              })
            : await window.api.createParty({
                name: name.trim(),
                phone: phone.trim() || null,
                address: address.trim() || null,
                openingBalance: openingBalance.trim() ? Number(openingBalance) : undefined,
              })
        reset()
        onSaved(saved)
      } catch {
        setError(`Could not ${isEdit ? 'save changes' : 'add party'}. Please try again.`)
        setSaving(false)
      }
    }

    if (isEdit) {
      run({ title: 'Save changes to this party', description: 'Editing a party needs the Owner password.' }, save)
    } else {
      await save()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-lg font-semibold text-slate-800">{isEdit ? 'Edit Party' : 'Add Party'}</h2>

        <form className="mt-4 flex flex-col gap-3" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Name
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Phone
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Address
            <textarea
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              rows={2}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </label>

          {!isEdit && (
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Opening balance (optional)
              <input
                type="number"
                step="0.01"
                value={openingBalance}
                onChange={(event) => setOpeningBalance(event.target.value)}
                placeholder="0"
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={saving}
              className="rounded px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Party'}
            </button>
          </div>
        </form>
      </div>
      {gate}
    </div>
  )
}
