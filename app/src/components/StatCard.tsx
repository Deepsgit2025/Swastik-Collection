import type { ReactNode } from 'react'

/**
 * One figure on a dashboard: a label, the number, and optional smaller detail
 * under it.
 *
 * Shared by the Owner and Salesman dashboards, and deliberately **dumb** — it
 * takes an already-formatted value and renders it. PHASE10.md section 4 turns
 * on which code path *fetches* what, so shared presentation is safe in a way a
 * shared data-loading component would not be: nothing here reaches for data,
 * so there is nothing here for a Salesman session to over-fetch.
 *
 * `detail` is what makes acceptance criterion 4 checkable by eye — the Cash and
 * UPI cards use it to show the sale half and the Payment-In half of the figure
 * separately, so a wrong total can be traced to which half is wrong rather than
 * just being wrong.
 */
export function StatCard({
  label,
  value,
  detail,
  emphasis = false,
}: {
  label: string
  value: string
  detail?: ReactNode
  /** Marks the headline figure of a screen — larger, darker. */
  emphasis?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white p-5">
      <span className="text-sm text-slate-500">{label}</span>
      <span
        className={
          emphasis
            ? 'text-3xl font-semibold text-slate-900'
            : 'text-2xl font-semibold text-slate-800'
        }
      >
        {value}
      </span>
      {detail != null && <span className="text-xs text-slate-500">{detail}</span>}
    </div>
  )
}
