import { useOwnerGate } from '../../auth/useOwnerGate.tsx'
import { useEffect, useState } from 'react'
import { formatDate } from '../../lib/format.ts'
import { validateScheduleTime } from '../../lib/backupSchedule.ts'
import type { BackupStatusView } from '../../types/backup.ts'
import { BUTTON_CLASS, INPUT_CLASS } from './formStyles.ts'

/**
 * Google Drive backup (PHASE12.md section 2) — connect, schedule, Backup Now,
 * and the attempt history.
 *
 * **The attempt list is not decoration.** A backup screen that only ever says
 * "Last backup: 21 Aug" hides a run of quiet failures behind one old success,
 * and this project has already spent two debugging sessions on exactly that
 * shape of problem in the WhatsApp send path — which is why `backup_log` has an
 * `error` column and why the reason is rendered here rather than left in a
 * table only a developer would read.
 *
 * The client secret is write-only from this screen's point of view: it is sent
 * when typed and never returned, so the field shows a placeholder once one is
 * on file. Leaving it blank on a later save keeps the stored one.
 */
export function GoogleDrivePanel() {
  const { run, gate } = useOwnerGate()
  const [status, setStatus] = useState<BackupStatusView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'connecting' | 'backing-up' | 'saving'>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [timeOfDay, setTimeOfDay] = useState('21:00')
  const [onAppClose, setOnAppClose] = useState(true)

  function applyStatus(next: BackupStatusView) {
    setStatus(next)
    setClientId(next.clientId)
    setClientSecret('')
    setTimeOfDay(next.schedule.timeOfDay)
    setOnAppClose(next.schedule.onAppClose)
  }

  useEffect(() => {
    let cancelled = false
    window.api
      .getBackupStatus()
      .then((next) => {
        if (!cancelled) applyStatus(next)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the backup settings.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function refresh() {
    try {
      applyStatus(await window.api.getBackupStatus())
    } catch {
      setLoadError('Could not reload the backup settings.')
    }
  }

  function handleSaveCredentials() {
    run(
      { title: 'Save Google Drive credentials', description: 'Enter the Owner password to continue.' },
      () => doSaveCredentials(),
    )
  }

  async function doSaveCredentials() {
    setError(null)
    setMessage(null)
    setBusy('saving')
    try {
      await window.api.setDriveCredentials({ clientId, clientSecret })
      await refresh()
      setMessage('Saved. You can connect Google Drive now.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save those credentials.')
    } finally {
      setBusy(null)
    }
  }

  function handleConnect() {
    run(
      { title: 'Connect Google Drive', description: 'Enter the Owner password to continue.' },
      () => doConnect(),
    )
  }

  async function doConnect() {
    setError(null)
    setMessage(null)
    setBusy('connecting')
    try {
      await window.api.connectDrive()
      await refresh()
      setMessage('Connected to Google Drive.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to Google Drive.')
    } finally {
      setBusy(null)
    }
  }

  function handleDisconnect() {
    run(
      { title: 'Disconnect Google Drive', description: 'Backups stop until Drive is connected again. Enter the Owner password to continue.' },
      () => doDisconnect(),
    )
  }

  async function doDisconnect() {
    setError(null)
    setMessage(null)
    try {
      await window.api.disconnectDrive()
      await refresh()
      setMessage('Disconnected. Backups will not run until Drive is connected again.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect.')
    }
  }

  function handleSaveSchedule() {
    // Checked before the password is asked for, so a bad time is reported by
    // the field the operator just edited rather than after a password prompt.
    const invalid = validateScheduleTime(timeOfDay)
    if (invalid) {
      setError(invalid)
      setMessage(null)
      return
    }
    run(
      { title: 'Save backup schedule', description: 'Enter the Owner password to continue.' },
      () => doSaveSchedule(),
    )
  }

  async function doSaveSchedule() {
    setError(null)
    setMessage(null)
    const invalid = validateScheduleTime(timeOfDay)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy('saving')
    try {
      await window.api.setBackupSchedule({ timeOfDay, onAppClose })
      await refresh()
      setMessage('Backup schedule saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the schedule.')
    } finally {
      setBusy(null)
    }
  }

  function handleBackupNow() {
    run(
      { title: 'Back up now', description: 'Enter the Owner password to continue.' },
      () => doBackupNow(),
    )
  }

  async function doBackupNow() {
    setError(null)
    setMessage(null)
    setBusy('backing-up')
    try {
      const result = await window.api.runBackupNow()
      await refresh()
      // A failed backup resolves rather than rejecting — it is an ordinary
      // outcome with a reason worth showing in place, and it is already in
      // backup_log either way.
      if (result.ok) setMessage(`Backed up ${result.fileName} to Google Drive.`)
      else setError(result.error ?? 'The backup did not complete.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The backup did not complete.')
    } finally {
      setBusy(null)
    }
  }

  const scheduleError = validateScheduleTime(timeOfDay)

  return (
    <section className="flex max-w-3xl flex-col gap-4 rounded-lg border border-slate-200 bg-white p-6">
      <div>
        <h2 className="text-base font-medium text-slate-800">Google Drive Backup</h2>
        <p className="mt-1 text-sm text-slate-500">
          A copy of the shop&apos;s database is uploaded to a folder in your own Google Drive. The app can only
          see files it puts there itself — it has no access to the rest of your Drive.
        </p>
      </div>

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}
      {!status && !loadError && <p className="text-sm text-slate-500">Loading…</p>}

      {status && (
        <>
          <div className="flex flex-col gap-4 rounded border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-medium text-slate-700">Google account</h3>
            {status.connected ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-green-700">
                  Connected{status.connectedEmail ? ` as ${status.connectedEmail}` : ''}
                </span>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="text-sm text-slate-600 underline hover:text-slate-900"
                >
                  Disconnect
                </button>
                <span className="w-full text-xs text-slate-500">
                  Disconnecting only forgets this computer&apos;s access. To revoke it fully, remove the app
                  under your Google Account&apos;s security settings.
                </span>
              </div>
            ) : (
              <>
                <p className="text-sm text-slate-600">
                  Not connected. Paste the Client ID and Secret from a Google Cloud OAuth client
                  (type: Desktop app), then connect — a Google sign-in page opens in your browser.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm text-slate-600">
                    Client ID
                    <input value={clientId} onChange={(e) => setClientId(e.target.value)} className={INPUT_CLASS} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-slate-600">
                    Client Secret
                    <input
                      type="password"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      placeholder={status.hasClientSecret ? 'Saved — type to replace' : ''}
                      className={INPUT_CLASS}
                    />
                  </label>
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={handleSaveCredentials}
                    disabled={busy != null || !clientId.trim()}
                    className={BUTTON_CLASS}
                  >
                    {busy === 'saving' ? 'Saving…' : 'Save credentials'}
                  </button>
                  <button
                    type="button"
                    onClick={handleConnect}
                    disabled={busy != null || !status.clientId || !status.hasClientSecret}
                    className={BUTTON_CLASS}
                  >
                    {busy === 'connecting' ? 'Waiting for Google…' : 'Connect Google Drive'}
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="flex flex-col gap-4 rounded border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-medium text-slate-700">Automatic backups</h3>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Every day at
                <input
                  type="time"
                  value={timeOfDay}
                  onChange={(e) => setTimeOfDay(e.target.value)}
                  aria-label="Daily backup time"
                  className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
                />
              </label>
              <label className="flex items-center gap-2 pb-2 text-sm text-slate-600">
                <input type="checkbox" checked={onAppClose} onChange={(e) => setOnAppClose(e.target.checked)} />
                Also back up when the app closes
              </label>
              <button
                type="button"
                onClick={handleSaveSchedule}
                disabled={busy != null || scheduleError != null}
                className={`${BUTTON_CLASS} mb-1`}
              >
                Save schedule
              </button>
            </div>
            <p className="text-xs text-slate-500">
              If the computer is off at the scheduled time, the backup runs the next time the app opens — a
              missed day is caught up, not skipped.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={handleBackupNow}
              disabled={busy != null || !status.connected}
              className={BUTTON_CLASS}
            >
              {busy === 'backing-up' ? 'Backing up…' : 'Backup Now'}
            </button>
            <span className="text-sm text-slate-600">
              {status.lastSuccessAt
                ? `Last successful backup: ${formatDate(status.lastSuccessAt)}`
                : 'No successful backup yet.'}
            </span>
          </div>

          {message && <p className="text-sm text-green-700">{message}</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}

          <div>
            <h3 className="mb-2 text-sm font-medium text-slate-700">Recent attempts</h3>
            {status.recentAttempts.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing yet.</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Trigger</th>
                    <th className="py-2 pr-4 font-medium">Result</th>
                    <th className="py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {status.recentAttempts.map((attempt) => (
                    <tr key={attempt.id} className="border-b border-slate-100 align-top">
                      <td className="py-2 pr-4 text-slate-600">{formatDate(attempt.created_at)}</td>
                      <td className="py-2 pr-4 capitalize text-slate-600">{attempt.triggered_by}</td>
                      <td className="py-2 pr-4">
                        <span className={attempt.status === 'success' ? 'text-green-700' : 'text-red-600'}>
                          {attempt.status === 'success' ? 'Backed up' : 'Failed'}
                        </span>
                      </td>
                      <td className="py-2 text-slate-500">
                        {/* The reason a failure failed, shown where the Owner is
                            already looking — not left in a table only a
                            developer would think to read. */}
                        {attempt.status === 'success' ? attempt.file_name : attempt.error}
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
