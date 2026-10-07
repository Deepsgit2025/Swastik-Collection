import { useAuth } from '../auth/AuthContext.tsx'
import { useShopSettings } from '../hooks/useShopSettings.ts'
import { WhatsAppStatusBadge } from './WhatsAppStatusBadge.tsx'

/**
 * Shop name on the right, WhatsApp status on the left.
 *
 * It showed "Name — Role" until 2026-08-27. With no login there is no name to
 * show and no role worth announcing: the ordinary state is the counter, which
 * would read as a permanent "Counter — Salesman" label that tells nobody
 * anything. What is worth announcing is the *other* state — that this window
 * is currently unlocked as the Owner — because that is temporary, consequential,
 * and otherwise invisible.
 */
export function TopBar() {
  const { elevated } = useAuth()
  const shop = useShopSettings()

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
      <WhatsAppStatusBadge />
      <div className="flex items-center gap-3">
        {elevated && (
          <span
            role="status"
            className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800"
          >
            Owner access — ends when this action finishes
          </span>
        )}
        <span className="text-sm font-medium text-slate-700">{shop?.shopName ?? ''}</span>
      </div>
    </header>
  )
}
