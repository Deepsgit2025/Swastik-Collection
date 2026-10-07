import { Link } from 'react-router-dom'

export interface QuickLink {
  label: string
  to: string
  /** Renders as an inert tile instead of a link — for a destination a later phase builds. */
  disabled?: boolean
  /** Hover text, used to explain a disabled tile. */
  title?: string
}

/**
 * The row of jump-off tiles at the foot of a dashboard (PHASE10.md sections
 * 1-2 — "quick links to …").
 *
 * Each dashboard passes its own list; this component has no idea which role is
 * looking at it, which is the point. The Owner's list and the Salesman's list
 * are written where each screen is, so what a role can jump to is visible in
 * that screen's own file rather than hidden behind a role check in here.
 *
 * A `disabled` tile renders as a plain div, not a `<Link>` to nowhere: an
 * enabled link to an unbuilt route would fall through App.tsx's catch-all and
 * bounce the operator back to the dashboard they just left, which reads like a
 * bug rather than a not-yet.
 */
export function QuickLinks({ links }: { links: QuickLink[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {links.map((link) =>
        link.disabled ? (
          <div
            key={link.to}
            title={link.title}
            aria-disabled="true"
            className="cursor-not-allowed rounded-lg border border-dashed border-slate-300 bg-slate-50 px-5 py-3 text-sm text-slate-400"
          >
            {link.label}
          </div>
        ) : (
          <Link
            key={link.to}
            to={link.to}
            title={link.title}
            className="rounded-lg border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:border-slate-400 hover:text-slate-900"
          >
            {link.label}
          </Link>
        ),
      )}
    </div>
  )
}
