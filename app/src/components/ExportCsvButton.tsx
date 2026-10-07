import { useState } from 'react'

/**
 * The Export CSV control shared by all three reports (PHASE11.md section 2).
 *
 * **`buildCsv` is a callback, not a prop holding pre-built text**, and that is
 * the design decision that makes acceptance criterion 4 hold: it closes over
 * the same state the screen is currently rendering, so pressing this button can
 * only ever write the numbers the Owner is looking at. The alternative — asking
 * the main process to re-run the query and format a file — could pick up a sale
 * that landed since the screen loaded, producing a file that is more current
 * than the screen and therefore *wrong* by the only definition that matters
 * when someone is reconciling the two.
 *
 * Disabled while there is nothing to export, so a click can't produce a file
 * containing only headers.
 */
export function ExportCsvButton({
  fileName,
  buildCsv,
  disabled = false,
}: {
  /** Default filename the save dialog opens with — build it with `reportFileName`. */
  fileName: string
  buildCsv: () => string
  disabled?: boolean
}) {
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleExport() {
    setSaving(true)
    setStatus(null)
    try {
      const result = await window.api.exportCsv(fileName, buildCsv())
      // A dismissed dialog is the operator changing their mind, not a failure —
      // it says nothing rather than reporting an error for a decision they made
      // deliberately.
      setStatus(result.saved ? `Saved to ${result.filePath}` : null)
    } catch {
      setStatus('Could not save the file.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={handleExport}
        disabled={disabled || saving}
        className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
      >
        {saving ? 'Saving…' : 'Export CSV'}
      </button>
      {status != null && <span className="text-xs text-slate-500">{status}</span>}
    </div>
  )
}
