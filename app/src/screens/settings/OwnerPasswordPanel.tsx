import { useState } from 'react'
import { useOwnerGate } from '../../auth/useOwnerGate.tsx'
import { validatePassword } from '../../lib/settingsValidation.ts'
import { INPUT_CLASS } from './formStyles.ts'

/**
 * Change the Owner password.
 *
 * New on 2026-08-27, and a consequence of that day's change rather than a
 * feature beside it. That password used to be typed once, at a login form, by
 * whoever opened the shop. It is now the **only** lock in the app — it stands
 * in front of Reports, Settings, the Drive restore and the retention purge —
 * and it gets typed at a counter with staff and customers in earshot, several
 * times a day. A secret in that position has to be rotatable, or the first time
 * someone reads it over a shoulder is permanent.
 *
 * The current password is required (`changeOwnerPassword`, src/db/users.ts).
 * That matters more here than it would elsewhere: the app sits unlocked at the
 * counter, so any moment the Owner walks away from an open Settings screen
 * would otherwise be a moment somebody could set a new password and take the
 * shop's data with it.
 *
 * **There is no recovery path if this is forgotten** — no email reset, no
 * admin console, nothing. The panel says so rather than letting an Owner find
 * out afterwards.
 */
export function OwnerPasswordPanel() {
  const { run, gate } = useOwnerGate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const strengthError = newPassword === '' ? null : validatePassword(newPassword)
  const mismatch = confirmPassword !== '' && newPassword !== confirmPassword
  const submittable =
    currentPassword !== '' && newPassword !== '' && !strengthError && !mismatch && confirmPassword !== ''

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!submittable || saving) return
    run(
      {
        title: 'Change the Owner password',
        description: 'Enter the CURRENT Owner password to continue. You will type it once more in the form afterwards.',
      },
      doSubmit,
    )
  }

  async function doSubmit() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await window.api.changeOwnerPassword(currentPassword, newPassword)
      // Cleared on success so the new password does not sit in React state
      // behind whatever the Owner does next on this screen.
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setNotice('Password changed. Use the new one the next time an edit or delete asks.')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not change the password.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-800">Owner Password</h2>
      <p className="mt-1 text-sm text-slate-500">
        This is what allows editing or deleting anything — parties, settings, backups, salesmen. There is no way to
        recover it if it is forgotten — write it down somewhere safe.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 flex max-w-sm flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          Current password
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            className={INPUT_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-slate-600">
          New password
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            className={INPUT_CLASS}
          />
          {strengthError && <span className="text-xs text-red-600">{strengthError}</span>}
        </label>

        <label className="flex flex-col gap-1 text-sm text-slate-600">
          Confirm new password
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            className={INPUT_CLASS}
          />
          {mismatch && <span className="text-xs text-red-600">The two new passwords do not match.</span>}
        </label>

        <button
          type="submit"
          disabled={!submittable || saving}
          className="self-start rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {saving ? 'Changing…' : 'Change Password'}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {gate}
    </section>
  )
}
