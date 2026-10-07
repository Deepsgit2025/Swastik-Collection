/**
 * The one input style every Settings panel uses.
 *
 * Shared as a constant rather than repeated per panel so the four panels can't
 * drift into looking like four different screens — the same reason
 * `StatCard`/`QuickLinks` exist for the dashboards. Presentation only; nothing
 * here loads data, which is what makes it safe to share (see
 * `DashboardScreen`'s note on why a shared *data-loading* component would not
 * be).
 */
export const INPUT_CLASS =
  'w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none'

/** The primary action button on each panel — Save, Create, Connect, Backup Now. */
export const BUTTON_CLASS =
  'rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300'
