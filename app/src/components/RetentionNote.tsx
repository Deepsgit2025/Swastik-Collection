import { RETENTION_TOTAL_DAYS } from '../lib/retention.ts'
import type { DateRange } from '../types/report.ts'

export interface RetentionNoteProps {
  /** The window the figures were actually measured over. */
  range: DateRange
  /** From the report payload — null when nothing has ever been purged. */
  cashRetentionCutoff: string | null
}

/**
 * Says why a long report under-reports cash sales (PHASE12.md section 3).
 *
 * Once the retention job has removed anything, a report reaching back past the
 * 30-day local window is missing those cash bills — correctly, by the client's
 * own rule, but invisibly. An Owner comparing "last quarter" against their
 * memory would otherwise conclude the app had lost their sales, which is a
 * worse outcome than the deletion itself.
 *
 * Renders **nothing** unless bills really are missing from the window on
 * screen: `cashRetentionCutoff` is null until a purge has actually happened,
 * and the range has to reach past it. A shop that never switched retention on
 * never sees this, and neither does a report over the last fortnight.
 *
 * Deliberately not an error or a warning — nothing has gone wrong. It is a
 * plain statement of policy, in the same register as the label beside the
 * setting that caused it.
 */
export function RetentionNote({ range, cashRetentionCutoff }: RetentionNoteProps) {
  if (!cashRetentionCutoff) return null
  if (!range.from || range.from >= cashRetentionCutoff) return null

  return (
    <p className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      Cash bills from before {cashRetentionCutoff} have been removed under the {RETENTION_TOTAL_DAYS}-day
      retention rule, so cash figures for the earlier part of this range are lower than what was actually rung
      up. Credit bills that customers have fully paid off are removed on the same rule, {RETENTION_TOTAL_DAYS} days
      after they were cleared.
    </p>
  )
}
