import { useState } from 'react'
import { AppShell } from '../components/AppShell.tsx'
import { DailySalesReport } from './reports/DailySalesReport.tsx'
import { PartyOutstandingReport } from './reports/PartyOutstandingReport.tsx'
import { SalesmanSalesReport } from './reports/SalesmanSalesReport.tsx'

/**
 * `/reports` (PHASE11.md section 1) — **Owner-only**, three reports as tabs
 * under the single path the spec names.
 *
 * **This component switches tabs and does nothing else. It must never fetch.**
 * Same rule as `DashboardScreen`, and for a related reason: each report owns
 * its own data, so an unopened tab has issued no query and holds no rows. A
 * container that loaded all three and passed them down would fetch every
 * report's data on arrival — including the party balances of a report nobody
 * opened.
 *
 * The route guard in `App.tsx` (`RequireRole allowedRoles={['owner']}`) keeps a
 * Salesman off this screen even via a hand-edited hash, and that is the *first*
 * layer, not the only one: every composer behind these four channels asserts
 * `report:view_all` before it queries, so a patched renderer that mounted this
 * screen anyway would get a `PermissionError` instead of data (PHASE11.md
 * section 4, acceptance criterion 5). There is no role check inside this file —
 * enforcement does not belong in a tab switcher.
 *
 * Mounting only the active tab (rather than rendering all three hidden) also
 * means switching away unmounts a report and its state, so returning to it
 * re-reads rather than showing figures from some earlier minute.
 */
const TABS = [
  { id: 'daily', label: 'Daily Sales' },
  { id: 'salesman', label: 'Salesman-wise' },
  { id: 'parties', label: 'Party Outstanding' },
] as const

type TabId = (typeof TABS)[number]['id']

export function ReportsScreen() {
  const [tab, setTab] = useState<TabId>('daily')

  return (
    <AppShell>
      <div className="flex flex-1 flex-col gap-6 overflow-auto p-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Reports</h1>
          <p className="mt-1 text-sm text-slate-500">
            Historical sales and outstanding balances. Export any report as CSV.
          </p>
        </div>

        <div role="tablist" aria-label="Reports" className="flex flex-wrap gap-1 border-b border-slate-200">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={
                tab === item.id
                  ? '-mb-px border-b-2 border-slate-800 px-4 py-2 text-sm font-medium text-slate-900'
                  : '-mb-px border-b-2 border-transparent px-4 py-2 text-sm text-slate-500 hover:text-slate-800'
              }
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'daily' && <DailySalesReport />}
        {tab === 'salesman' && <SalesmanSalesReport />}
        {tab === 'parties' && <PartyOutstandingReport />}
      </div>
    </AppShell>
  )
}
