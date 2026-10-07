import { useState } from 'react'
import type { FormEvent } from 'react'
import type { PartyDetail } from '../types/party.ts'

interface QuickAddPartyModalProps {
  isOpen: boolean
  onClose: () => void
  onCreated: (party: PartyDetail) => void
}

/**
 * Reusable name+phone-only quick-add (PHASE3.md section 1 & 4). Built now,
 * ahead of the Phase 5 sale screen that will actually trigger it — no "+ New
 * Party" button exists anywhere yet, since the sale flow it belongs to
 * doesn't exist this phase. Phase 5 imports this component as-is and renders
 * it from its own trigger; nothing here should need to change to support
 * that. Deliberately has no address/balance field to accept even if a caller
 * tried to pass one — `QuickAddPartyInput` doesn't have those fields either,
 * so the "Salesman only ever gets name+phone" rule holds independent of
 * which role opens it (both roles are allowed to call `quickAddParty`, per
 * PHASE3.md section 2 — Owner may use it too rather than the full form).
 */
export function QuickAddPartyModal({ isOpen, onClose, onCreated }: QuickAddPartyModalProps) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (!isOpen) return null

  function reset() {
    setName('')
    setPhone('')
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
    if (!phone.trim()) {
      setError('Phone is required.')
      return
    }

    setSaving(true)
    try {
      const party = await window.api.quickAddParty({ name: name.trim(), phone: phone.trim() })
      reset()
      onCreated(party)
    } catch {
      setError('Could not add party. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-lg font-semibold text-slate-800">New Party</h2>
        <p className="mt-1 text-sm text-slate-500">Quick-add — just enough to link this sale.</p>

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
              {saving ? 'Adding…' : 'Add Party'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
