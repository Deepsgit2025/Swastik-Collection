import { useOwnerGate } from '../../auth/useOwnerGate.tsx'
import { useState } from 'react'
import type { RestorePoint } from '../../types/backup.ts'
import { BUTTON_CLASS, INPUT_CLASS } from './formStyles.ts'

/** The word the Owner has to type. Deliberately not a yes/no dialog — see the panel's own note. */
const CONFIRM_WORD = 'RESTORE'

function describeSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Restore from a Google Drive backup (PHASE12.md section 2).
 *
 * **A separate panel from Backup on purpose.** This is not something to click
 * while looking for the Backup Now button, so it does not sit next to it, and
 * the restore points are not even fetched until the Owner asks for them —
 * opening Settings should not quietly hit Drive.
 *
 * Section 2 asks for a confirmation that is "unambiguous about what's about to
 * happen", so this states three specific things before enabling anything: which
 * snapshot, that everything recorded since it was taken will be gone, and that
 * the app will restart. Typing the word is what enables the button — a yes/no
 * dialog is dismissed reflexively, and this is the one irreversible-looking
 * action in the app. (It is in fact recoverable: the database being replaced is
 * copied aside first. That copy is a developer's safety net, not something to
 * wave at the Owner as a reason to be casual, so the wording does not lean on
 * it.)
 */
export function RestorePanel() {
  const { run, gate } = useOwnerGate()
  const [points, setPoints] = useState<RestorePoint[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<RestorePoint | null>(null)
  const [typed, setTyped] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleLoad() {
    setError(null)
    setLoading(true)
    try {
      setPoints(await window.api.listRestorePoints())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not list the backups in Google Drive.')
    } finally {
      setLoading(false)
    }
  }

  function handleRestore() {
    if (!selected || typed !== CONFIRM_WORD) return
    run(
      { title: 'Restore from backup', description: 'This replaces everything in the app with the backup. Enter the Owner password to continue.' },
      () => doRestore(),
    )
  }

  async function doRestore() {
    if (!selected || typed !== CONFIRM_WORD) return
    setError(null)
    setRestoring(true)
    try {
      // Does not resolve on success — the app relaunches onto the restored
      // database, because every open screen is showing rows from the one that
      // was just replaced.
      await window.api.restoreFromBackup(selected.driveFileId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The restore did not complete.')
      setRestoring(false)
    }
  }

  return (
    <section className="flex max-w-3xl flex-col gap-4 rounded-lg border border-red-200 bg-white p-6">
      <div>
        <h2 className="text-base font-medium text-slate-800">Restore from a Backup</h2>
        <p className="mt-1 text-sm text-slate-500">
          Replaces everything currently in the app with the contents of a backup. Only use this if the current
          data is lost or wrong.
        </p>
      </div>

      <div>
        <button type="button" onClick={handleLoad} disabled={loading} className={BUTTON_CLASS}>
          {loading ? 'Loading…' : 'Show available backups'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {points && points.length === 0 && (
        <p className="text-sm text-slate-500">There are no backups in Google Drive yet.</p>
      )}

      {points && points.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-4 font-medium">Backup taken</th>
              <th className="py-2 pr-4 font-medium">Size</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.driveFileId} className="border-b border-slate-100">
                <td className="py-2 pr-4 text-slate-700">{point.takenAt}</td>
                <td className="py-2 pr-4 text-slate-500">{describeSize(point.sizeBytes)}</td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(point)
                      setTyped('')
                      setError(null)
                    }}
                    className="text-sm text-slate-600 underline hover:text-slate-900"
                  >
                    Select
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <div className="flex flex-col gap-3 rounded border border-red-300 bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">
            This will replace all current data with the backup from {selected.takenAt}.
          </p>
          <ul className="list-disc pl-5 text-sm text-red-800">
            <li>
              Every sale, payment, expense and customer recorded <strong>after {selected.takenAt}</strong> will
              be gone.
            </li>
            <li>Logins created since then will be gone, and any since deleted will come back.</li>
            <li>The app will close and reopen as soon as this finishes.</li>
          </ul>
          <label className="flex flex-col gap-1 text-sm text-red-800">
            Type {CONFIRM_WORD} to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label={`Type ${CONFIRM_WORD} to confirm`}
              className={INPUT_CLASS}
            />
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleRestore}
              disabled={typed !== CONFIRM_WORD || restoring}
              className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-red-300"
            >
              {restoring ? 'Restoring…' : `Restore from ${selected.takenAt}`}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelected(null)
                setTyped('')
              }}
              disabled={restoring}
              className="text-sm text-slate-600 underline hover:text-slate-900"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {gate}
    </section>
  )
}
