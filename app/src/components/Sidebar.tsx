import { NavLink } from 'react-router-dom'
import { NAV_ITEMS } from './navItems.ts'

/**
 * The nav. One list for everyone since 2026-08-27 — there is no role to key it
 * on any more, because nobody logs in.
 *
 * There is no Logout button. Logging out was the only way to end a session, and
 * there is no session to end: the app is always the counter, and Owner access
 * lasts only for the one action that asked for the password (`useOwnerGate`).
 * A button that did nothing but re-open the same billing screen would be a lie
 * about what it protects.
 */
export function Sidebar() {
  return (
    <aside className="flex h-screen w-56 flex-col justify-between bg-slate-900 text-slate-100">
      <nav className="flex flex-col gap-1 p-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center justify-between gap-2 rounded px-3 py-2 text-sm ${
                isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`
            }
          >
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
