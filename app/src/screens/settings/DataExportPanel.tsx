import { useState } from 'react'
import { RETENTION_TOTAL_DAYS } from '../../lib/retention.ts'
import { BUTTON_CLASS } from './formStyles.ts'

/**
 * Full sales-history export (PHASE12.md section 4).
 *
 * Placed immediately after the retention panel on purpose: section 4 says this
 * exists "specifically so the Owner can pull anything they want to keep
 * permanently before the day-90 window closes on it", and a way out of a
 * deletion rule is most useful next to the deletion rule. It is a panel of its
 * own rather than a button inside that one so it stays findable by someone who
 * is simply looking for their data.
 *
 * Independent of the Phase 11 report exports in every sense: no date range, no
 * summary, every sale still in the database with its line items — and built in
 * the main process rather than from anything on screen, because there is no
 * screen that shows all of it.
 */
export function DataExportPanel() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleExport() {
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      const result = await window.api.exportSalesHistory()
      // A dismissed save dialog is a choice, not a failure — the screen says
      // nothing, exactly as the Phase 11 exports and the print path do.
      if (!result.saved) return
      setMessage(
        `Saved ${result.saleCount} bill(s) across ${result.rowCount} item row(s) to ${result.filePath}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export the sales history.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex max-w-3xl flex-col gap-4 rounded-lg border border-slate-200 bg-white p-6">
      <div>
        <h2 className="text-base font-medium text-slate-800">Export Sales History</h2>
        <p className="mt-1 text-sm text-slate-500">
          Saves every bill still in the app — with its items, customer and payment split — to a spreadsheet file
          you keep. Use this to keep a permanent copy of anything you want before it is removed under the{' '}
          {RETENTION_TOTAL_DAYS}-day rule above.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Bills that have already been removed cannot be exported — they are gone. This covers everything the app
          still holds today.
        </p>
      </div>

      <div>
        <button type="button" onClick={handleExport} disabled={busy} className={BUTTON_CLASS}>
          {busy ? 'Exporting…' : 'Export full sales history (CSV)'}
        </button>
      </div>

      {message && <p className="text-sm text-green-700">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  )
}
