import { useOwnerGate } from '../../auth/useOwnerGate.tsx'
import { useEffect, useState } from 'react'
import { formatDate } from '../../lib/format.ts'
import { RETENTION_LOCAL_DAYS, RETENTION_TOTAL_DAYS } from '../../lib/retention.ts'
import type { PurgeLogRow, RetentionPreview } from '../../types/retention.ts'
import { BUTTON_CLASS } from './formStyles.ts'

/**
 * The retention/purge job (PHASE12.md section 3), and PHASE12.md section 4's
 * plain label about permanent deletion — which belongs beside this switch and
 * nowhere else.
 *
 * Deliberately the most cautious panel in the app. It ships switched **off**,
 * it will not run while it is off, and the only thing it does before the Owner
 * turns it on is *tell them what it would do*. Nothing here nags: section 4
 * asks for a clear honest label next to the setting, not a dialog on every
 * launch.
 *
 * The held-back count is the part worth reading. Those are bills old enough to
 * remove that no successful backup has captured — the safeguard refusing to
 * destroy the only copy. A number that keeps climbing means Drive backups are
 * failing, and it is on screen for exactly that reason.
 */
export function RetentionPanel() {
  const { run, gate } = useOwnerGate()
  const [preview, setPreview] = useState<RetentionPreview | null>(null)
  const [purgeLog, setPurgeLog] = useState<PurgeLogRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'previewing' | 'running' | 'toggling'>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    const [next, log] = await Promise.all([window.api.previewRetention(), window.api.getPurgeLog()])
    setPreview(next)
    setPurgeLog(log)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.previewRetention(), window.api.getPurgeLog()])
      .then(([next, log]) => {
        if (cancelled) return
        setPreview(next)
        setPurgeLog(log)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the retention status.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  function handleToggle(enabled: boolean) {
    run(
      { title: 'Change automatic deletion', description: 'Turning this on lets the app permanently delete old bills. Enter the Owner password to continue.' },
      () => doToggle(enabled),
    )
  }

  async function doToggle(enabled: boolean) {
    setError(null)
    setMessage(null)
    setBusy('toggling')
    try {
      await window.api.setRetentionEnabled(enabled)
      await refresh()
      setMessage(
        enabled
          ? 'Automatic deletion is on. Old cash bills and settled credit bills will be removed as described above.'
          : 'Automatic deletion is off. Nothing will be removed.',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change that setting.')
    } finally {
      setBusy(null)
    }
  }

  async function handlePreview() {
    setError(null)
    setMessage(null)
    setBusy('previewing')
    try {
      await refresh()
      setMessage('This is what would be removed. Nothing has been changed.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not work out what would be removed.')
    } finally {
      setBusy(null)
    }
  }

  function handleRun() {
    run(
      { title: 'Run clean-up now', description: 'This permanently deletes old bills. Enter the Owner password to continue.' },
      () => doRun(),
    )
  }

  async function doRun() {
    setError(null)
    setMessage(null)
    setBusy('running')
    try {
      const result = await window.api.runRetention()
      await refresh()
      if (result.error) setError(result.error)
      else {
        setMessage(
          `Removed ${result.purgedLocally} bill(s) from this computer and ${result.snapshotsDeleted} expired backup(s) from Google Drive.`,
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The clean-up did not complete.')
    } finally {
      setBusy(null)
    }
  }

  // Cash and settled-credit bills are counted together: the Owner's question is
  // "how many bills will go", not which rule removes them.
  const readyCount = preview ? preview.dueForLocalPurge.length + preview.creditDueForLocalPurge.length : 0
  const waitingCount = preview ? preview.heldBack.length + preview.creditHeldBack.length : 0

  return (
    <section className="flex max-w-3xl flex-col gap-4 rounded-lg border border-amber-300 bg-white p-6">
      <div>
        <h2 className="text-base font-medium text-slate-800">Old Bill Clean-up</h2>
        {/*
          PHASE12.md section 4's honest label, stated once, next to the setting
          it describes. Cash bills only, and the word "permanently" is not
          softened — this is the one thing in the app that cannot be undone.
        */}
        <p className="mt-1 text-sm text-slate-600">
          Cash bills are kept on this computer for <strong>{RETENTION_LOCAL_DAYS} days</strong>, then in your
          Google Drive backup only, and are <strong>permanently deleted after {RETENTION_TOTAL_DAYS} days</strong>{' '}
          — from this computer and from Google Drive, with no copy kept anywhere. This cannot be undone.
        </p>
        <p className="mt-2 text-sm text-slate-600">
          <strong>Credit bills are never removed while any balance is owed.</strong> Once a customer has paid
          everything off, their credit bills and payments follow the same clock — {RETENTION_LOCAL_DAYS} days here,
          then Google Drive only, and <strong>permanently deleted {RETENTION_TOTAL_DAYS} days after they were cleared</strong>.
          Borrowing again starts the clock over. A bill is also never removed until a Google Drive backup has
          successfully saved it.
        </p>
      </div>

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}
      {!preview && !loadError && <p className="text-sm text-slate-500">Loading…</p>}

      {preview && (
        <>
          <div className="flex flex-col gap-3 rounded border border-slate-200 bg-slate-50 p-4">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={preview.enabled}
                disabled={busy != null}
                onChange={(event) => handleToggle(event.target.checked)}
              />
              Automatically remove old bills
            </label>
            <p className="text-xs text-slate-500">
              {preview.enabled
                ? 'Runs when the app opens and once an hour after that.'
                : 'Off. Nothing is removed while this is unchecked — you can still preview what would be.'}
              {preview.lastRunAt ? ` Last checked ${formatDate(preview.lastRunAt)}.` : ''}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Ready to remove" value={readyCount} />
            <Stat label="Waiting for a backup" value={waitingCount} tone={waitingCount > 0 ? 'warn' : 'plain'} />
            <Stat
              label="Expired Drive backups"
              value={preview.snapshotsToDelete?.length ?? null}
              hint={preview.snapshotsToDelete == null ? 'Drive not connected' : undefined}
            />
          </div>

          {/*
            The safeguard doing its job, said out loud. These bills are past the
            30-day mark but have never been captured by a successful backup, so
            they are deliberately left alone.
          */}
          {waitingCount > 0 && (
            <p className="text-sm text-amber-800">
              {waitingCount} old bill(s) are being kept because no Google Drive backup has saved them
              yet. They will not be removed until one has.
            </p>
          )}

          {/*
            Past the final-day deadline and still never backed up. The rule says
            delete; the safeguard says never destroy the only copy. The
            safeguard wins, and the Owner needs to know why.
          */}
          {preview.overdueNeverBackedUp.length > 0 && (
            <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              <strong>{preview.overdueNeverBackedUp.length} bill(s) are past their deletion date but have never
              been backed up.</strong>{' '}
              They are being kept rather than deleted, because deleting them would destroy the only copy. Fix
              Google Drive backups above.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={handlePreview} disabled={busy != null} className={BUTTON_CLASS}>
              {busy === 'previewing' ? 'Checking…' : 'Preview what would be removed'}
            </button>
            <button
              type="button"
              onClick={handleRun}
              disabled={busy != null || !preview.enabled}
              className="rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-amber-200"
              title={preview.enabled ? undefined : 'Turn on automatic removal first'}
            >
              {busy === 'running' ? 'Removing…' : 'Run clean-up now'}
            </button>
          </div>

          {message && <p className="text-sm text-green-700">{message}</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}

          <div>
            <h3 className="mb-2 text-sm font-medium text-slate-700">What has been removed</h3>
            {purgeLog.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing has been removed yet.</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-4 font-medium">Removed on</th>
                    <th className="py-2 pr-4 font-medium">What</th>
                    <th className="py-2 font-medium">Originally from</th>
                  </tr>
                </thead>
                <tbody>
                  {purgeLog.map((entry) => (
                    <tr key={entry.id} className="border-b border-slate-100">
                      <td className="py-2 pr-4 text-slate-600">{formatDate(entry.created_at)}</td>
                      <td className="py-2 pr-4 text-slate-700">
                        {entry.action === 'local_purge' ? `Bill #${entry.sale_id}` : `Backup ${entry.file_name}`}
                      </td>
                      <td className="py-2 text-slate-500">
                        {entry.sale_created_at ? formatDate(entry.sale_created_at) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
      {gate}
    </section>
  )
}

function Stat({
  label,
  value,
  tone = 'plain',
  hint,
}: {
  label: string
  value: number | null
  tone?: 'plain' | 'warn'
  hint?: string
}) {
  return (
    <div className="rounded border border-slate-200 p-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-lg font-semibold ${tone === 'warn' ? 'text-amber-700' : 'text-slate-800'}`}>
        {value ?? '—'}
      </p>
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
    </div>
  )
}
