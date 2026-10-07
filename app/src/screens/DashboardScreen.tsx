import { AppShell } from '../components/AppShell.tsx'
import { OwnerDashboard } from './OwnerDashboard.tsx'

/**
 * `/dashboard` — the shop's day in money.
 *
 * It forked on role until 2026-08-27, rendering `SalesmanDashboard` for a
 * salesman session and `OwnerDashboard` for an Owner. Both the fork and the
 * salesman view are gone with the salesman login: there is one dashboard, it
 * is shop-wide, and open to the counter since 2026-09-19 (it only reads).
 *
 * **It still must never fetch.** `OwnerDashboard` owns its own data, and this
 * file exists only to wrap it in the shell — the moment a container loads data
 * and passes it down, the fetch happens wherever the container mounts rather
 * than where an Owner actually asked for it.
 */
export function DashboardScreen() {
  return (
    <AppShell>
      <OwnerDashboard />
    </AppShell>
  )
}
