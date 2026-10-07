import { AppShell } from '../components/AppShell.tsx'
import { ShopDetailsPanel } from './settings/ShopDetailsPanel.tsx'
import { SalesmenPanel } from './settings/SalesmenPanel.tsx'
import { OwnerPasswordPanel } from './settings/OwnerPasswordPanel.tsx'
import { GoogleDrivePanel } from './settings/GoogleDrivePanel.tsx'
import { RestorePanel } from './settings/RestorePanel.tsx'
import { RetentionPanel } from './settings/RetentionPanel.tsx'
import { DataExportPanel } from './settings/DataExportPanel.tsx'

/**
 * Settings (PHASE12.md sections 1-2).
 *
 * **Composes and does nothing else**, the same discipline `ReportsScreen` and
 * `DashboardScreen` document: each panel owns its own fetch, so a panel that is
 * never rendered has issued no query. That matters here more than on those
 * screens — `RestorePanel` talks to Google Drive, and merely opening Settings
 * should not reach across the network.
 *
 * The panels live in `src/screens/settings/`, mirroring `src/screens/reports/`.
 * They were inline until Google Drive backup arrived and made four of them.
 *
 * Open to the counter since 2026-09-19 (the Owner lock on screens was
 * removed), so anyone can *read* it. Every panel's writes - saving shop details,
 * backup and restore, the clean-up job, salesmen, the Owner password - ask for
 * the Owner password when clicked (`useOwnerGate`), and each call behind them
 * still asserts `settings:edit`/`user:manage`/`backup:run`/`backup:restore` etc.
 * against the main process's own session.
 */
export function SettingsScreen() {
  return (
    <AppShell>
      <div className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">
            Shop details, staff logins, backups, and how long old bills are kept. Only the Owner can open this
            screen.
          </p>
        </div>

        <ShopDetailsPanel />
        <SalesmenPanel />
        <OwnerPasswordPanel />
        <GoogleDrivePanel />
        <RetentionPanel />
        <DataExportPanel />
        <RestorePanel />
      </div>
    </AppShell>
  )
}
