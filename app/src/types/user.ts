import type {
  CreatePartyInput,
  PartyDetail,
  PartyLedgerResult,
  PartyListFilters,
  PartyListRow,
  QuickAddPartyInput,
  UpdatePartyInput,
} from './party.ts'
import type { BarcodeLabelListFilters, BarcodeLabelRow, CreateBarcodeLabelInput } from './barcodeLabel.ts'
import type { CreateSaleInput, SaleRecord } from './sale.ts'
import type { RecordPaymentInput, RecordPaymentResult } from './payment.ts'
import type { ExpenseListFilters, ExpenseListRow, ExpenseRecord, LogExpenseInput } from './expense.ts'
import type { LabelSize, ShopSettings, ShopSettingsInput } from './settings.ts'
import type { BackupSchedule, BackupStatusView, RestorePoint, RunBackupResult } from './backup.ts'
import type { PurgeLogRow, RetentionPreview, RetentionRunResult } from './retention.ts'
import type {
  DailySalesReportData,
  DateRange,
  ExportCsvResult,
  OwnerDashboardData,
  PartyOutstandingReportData,
  SalesLedgerRow,
  SalesmanReportData,
  SalesmanSaleRow,
} from './report.ts'
import type { BillDeliveryRow, WhatsAppAckEvent, WhatsAppState } from './whatsapp.ts'
import type { SalesmanListFilters, SalesmanRow } from './salesman.ts'

export type Role = 'owner' | 'salesman'

export interface SafeUser {
  id: number
  username: string
  role: Role
  full_name: string
}

/**
 * The outcome of typing the Owner password at a locked module.
 *
 * `ok: false` carries no detail about *why* beyond a message, and the message
 * never distinguishes "wrong password" from anything else — there is one
 * account and one secret, so there is nothing to enumerate. `retryAfterMs` is
 * the throttle telling the screen how long to disable the button for
 * (electron/unlockThrottle.ts).
 */
export type UnlockResult =
  | { ok: true; user: SafeUser }
  | { ok: false; error: string; retryAfterMs: number }

/**
 * One `users` row minus `password_hash` — the hash must never reach the
 * renderer, which is the reason password checking lives in the main process at
 * all (electron/auth.ts).
 *
 * Barely used since 2026-08-27: the only accounts left are the Owner, the
 * reserved `__counter__` row, and whatever salesman logins migration 012
 * deactivated. Kept as the return shape of `changeOwnerPassword`.
 */
export interface UserListRow {
  id: number
  username: string
  full_name: string
  role: Role
  /** SQLite has no boolean: 1 = can log in, 0 = soft-disabled. Never deleted — old sales still reference this row. */
  is_active: number
  created_at: string
}

/*
 * `CreateSalesmanInput` stood here until 2026-08-27. Settings no longer creates
 * logins at all: a salesman is a name in the `salesmen` table
 * (src/types/salesman.ts) with no username, no password and no way in.
 */

/**
 * None of the write methods below take a `user`/role argument — the main
 * process identifies the caller itself from the session it recorded at
 * login, keyed by IPC sender (see electron/session.ts), rather than trusting
 * a value the renderer passes on each call.
 */
export interface ElectronApi {
  /**
   * Establishes this window's baseline session — the counter — and says who
   * that is (client decision, 2026-08-27: no login screen).
   *
   * Takes no argument, which is the point: there is nothing here for a patched
   * renderer to supply. The identity is the reserved `__counter__` row,
   * resolved main-side, and its `role` decides what every subsequent IPC call
   * is allowed to do. Called once at launch, before any route renders.
   */
  startSession: () => Promise<SafeUser>
  /**
   * Raises this window to the Owner for as long as an Owner-only module is
   * open. The password is verified against the `users` table in the main
   * process; the renderer never sees a hash.
   *
   * On success the main process's session map now holds the Owner, so **every**
   * later IPC call from this window is genuinely Owner-authorised — this is a
   * real privilege change, not a flag the UI reads. Which is exactly why
   * `lockSession` below must be called the moment the module is left.
   */
  unlockOwner: (password: string) => Promise<UnlockResult>
  /**
   * Drops this window back to the counter. Called when an Owner-only screen
   * unmounts — the client chose "locks as soon as you leave the module" — and
   * safe to call when already locked.
   */
  lockSession: () => Promise<SafeUser>
  getParties: (filters?: PartyListFilters) => Promise<PartyListRow[]>
  getPartyLedger: (partyId: number) => Promise<PartyLedgerResult | null>
  createParty: (data: CreatePartyInput) => Promise<PartyDetail>
  quickAddParty: (data: QuickAddPartyInput) => Promise<PartyDetail>
  updateParty: (id: number, data: UpdatePartyInput) => Promise<PartyDetail>
  deleteParty: (id: number) => Promise<void>
  getBarcodeLabels: (filters?: BarcodeLabelListFilters) => Promise<BarcodeLabelRow[]>
  createBarcodeLabel: (data: CreateBarcodeLabelInput) => Promise<BarcodeLabelRow>
  createSale: (data: CreateSaleInput) => Promise<SaleRecord>
  /**
   * Records a Payment-In against a party's balance (PHASE8.md section 2).
   * Both roles are allowed. Resolves with the payment plus the *already
   * updated* party record, so the screen can show the new balance without a
   * refetch. Nothing happens after the write — this flow is not WhatsApp-
   * gated and has no print step, unlike a sale.
   */
  recordPayment: (data: RecordPaymentInput) => Promise<RecordPaymentResult>
  /**
   * The shop-wide expense list, newest first, optionally narrowed to an
   * inclusive date range (PHASE9.md section 1). Both roles see every
   * expense — it is not scoped to the caller's own rows.
   */
  getExpenses: (filters?: ExpenseListFilters) => Promise<ExpenseListRow[]>
  /**
   * Logs a new expense (PHASE9.md section 2). Allowed for **both** roles —
   * the confirmed decision in section 0, reversing an earlier Owner-only
   * assumption. Add-only: there is no edit or delete counterpart on this API,
   * and `expense:edit`/`expense:delete` stay Owner-only in the PERMISSIONS
   * table for a later phase to build a screen against.
   */
  logExpense: (data: LogExpenseInput) => Promise<ExpenseRecord>
  /**
   * Owner-only (PHASE10.md section 1). Every figure the Owner dashboard shows,
   * for **today**, read in one round trip so they all describe the same window.
   *
   * Takes no range argument on purpose: "today" is computed in the main
   * process, so a patched renderer cannot widen the window, and the day has one
   * clock. Phase 11's Reports screens are what add a caller-supplied range.
   *
   * Rejects with `PermissionError` from a Salesman session — `report:view_all`
   * is asserted before any query runs. The preload surface is shared because it
   * is built before login and so cannot be role-scoped; that gate is what makes
   * a shared surface safe.
   */
  getOwnerDashboard: () => Promise<OwnerDashboardData>
  /**
   * The Daily Sales Report over any range (PHASE11.md section 1) — **Owner
   * only**, rejecting with `PermissionError` from a Salesman session.
   *
   * Returns the identical `SalesSummary` shape `getOwnerDashboard` does, from
   * the identical query function. Narrowed to today, every figure here must
   * equal the Owner dashboard's — that is acceptance criterion 1, and the
   * shared shape is what makes it hold rather than a coincidence to re-check.
   *
   * Unlike the dashboard channels this takes a range, validated main-side: both
   * ends required, real calendar days, `from` no later than `to`. A malformed
   * range rejects rather than quietly matching no rows.
   */
  getDailySalesReport: (range: DateRange) => Promise<DailySalesReportData>
  /** Per-salesman totals over a range (PHASE11.md section 1) — Owner only. The drill-down is `getSalesmanSales`. */
  getSalesmanReport: (range: DateRange) => Promise<SalesmanReportData>
  /**
   * The individual sales behind one salesman's row (PHASE11.md section 1's
   * drill-down) — Owner only, new in Phase 11.
   *
   * `salesmanId` is a filter, not an identity claim: the caller is still
   * resolved from the main-process session, and `report:view_all` still gates
   * the result. Summing these rows' `grandTotal` reproduces that salesman's
   * `total` in `getSalesmanReport` for the same range.
   *
   * **Null is meaningful** — it drills into the unassigned bucket, the bills
   * saved with no salesman picked, which is a row in the breakdown like any
   * other.
   */
  getSalesmanSales: (salesmanId: number | null, range: DateRange) => Promise<SalesmanSaleRow[]>
  /**
   * Every bill in a range, one row each — the Sales module's table (client
   * request, 2026-08-27). Owner only.
   *
   * Distinct from `getSalesmanSales` above, which lists one person's bills;
   * this is the flat shop-wide list, carrying the salesman name on every row so
   * the screen can sort by it. Over the same range, its rows sum to
   * `getSalesmanReport`'s totals — both filter through the same day-boundary
   * clause, which is what lets one screen show both without them disagreeing.
   */
  getSalesLedger: (range: DateRange) => Promise<SalesLedgerRow[]>
  /**
   * Every party carrying a non-zero balance, plus the shop-wide outstanding
   * total (PHASE11.md section 1) — Owner only.
   *
   * No range: a live snapshot, like the dashboard's Outstanding Credit card.
   * `outstandingTotal` counts positives only and so equals the sum of the
   * *positive* rows, not of all of them — overpaid parties appear in the list
   * but must not net off someone else's debt.
   */
  getPartyOutstandingReport: () => Promise<PartyOutstandingReportData>
  /**
   * Saves an already-built CSV to a file the Owner picks (PHASE11.md section
   * 2) — Owner only.
   *
   * The renderer passes finished text rather than asking the main process to
   * rebuild it, so the file can only ever contain what the screen displayed
   * (acceptance criterion 4). Resolves `{saved: false}` when the save dialog is
   * dismissed — a normal choice, not an error.
   */
  exportCsv: (defaultFileName: string, csvText: string) => Promise<ExportCsvResult>
  /**
   * Checks the gate (PHASE7.md section 2 — rejected server-side if
   * `canPrintSale` isn't satisfied, so the button's disabled state can't be
   * bypassed by a direct call), prints via the main process, and only then
   * sets `printed`. Rejects if the operator cancels the print dialog.
   */
  printSale: (saleId: number) => Promise<SaleRecord>
  /** Owner-only (assertPermission'd in main.ts) — the "print anyway" override on a WhatsApp send failure. */
  usePrintOverride: (saleId: number) => Promise<SaleRecord>
  /**
   * Prints the current page (whatever `@media print` reveals — i.e. the
   * mounted `.print-sheet`). Used for Phase 4's barcode labels. Printing must
   * go through the main process: Electron has no print-preview UI, so a
   * renderer-side `window.print()` opens a dead "This app doesn't support
   * print preview" window instead of reaching a printer.
   */
  printPage: () => Promise<void>
  getLabelSize: () => Promise<LabelSize>
  setLabelSize: (size: LabelSize) => Promise<LabelSize>
  /**
   * The shop's own details (PHASE12.md section 1) — name, address, phone and
   * the Owner's WhatsApp number, from the `settings` table.
   *
   * Readable by **both** roles: a Salesman prints bills, and this is the bill
   * header. `setShopSettings` below is where the Owner-only rule lives.
   *
   * This is now the only source of those values. The hardcoded constants
   * Phases 6 and 7 used (`src/lib/shopInfo.ts`,
   * `electron/whatsapp/config.ts`) are deleted — the printed bill and the
   * WhatsApp bill image read the same rows, so they can no longer drift.
   */
  getShopSettings: () => Promise<ShopSettings>
  /** Owner-only (`settings:edit`, asserted in `setShopSettings`). Replaces all four fields at once; rejects without writing anything if any field fails validation. */
  setShopSettings: (input: ShopSettingsInput) => Promise<ShopSettings>
  /**
   * The salesman names offered on the sale screen and administered in
   * Settings (2026-08-27).
   *
   * The read is **open to the counter** — the sale screen's dropdown needs it
   * and a list of first names is not shop data. The three writes are Owner-only
   * via `salesman:manage`, asserted inside each function.
   */
  getSalesmen: (filters?: SalesmanListFilters) => Promise<SalesmanRow[]>
  /** Owner-only (`salesman:manage`). Rejects a duplicate name — the sale screen's dropdown would be unusable with two identical entries. */
  createSalesman: (name: string) => Promise<SalesmanRow>
  /** Owner-only (`salesman:manage`). Renaming corrects the name on every past bill too, since reports resolve it by join — see `renameSalesman`. */
  renameSalesman: (id: number, name: string) => Promise<SalesmanRow>
  /** Owner-only (`salesman:manage`) — soft-disable/re-enable. **Never a delete**: `sales.salesman_id` references the row, so removing one would strip the attribution off every bill that person rang up. */
  setSalesmanActive: (id: number, isActive: boolean) => Promise<SalesmanRow>
  /**
   * Owner-only (`user:manage`) — changes the Owner's own password, current
   * password required.
   *
   * Not a Phase 12 leftover but a consequence of the 2026-08-27 change: that
   * password is now the only lock in the app and gets typed at a counter with
   * customers and staff watching, so being able to rotate it is part of the
   * gate rather than an extra.
   */
  changeOwnerPassword: (currentPassword: string, newPassword: string) => Promise<UserListRow>
  /**
   * Owner-only (`backup:run`) — everything the Google Drive panel renders:
   * connection state, schedule, last successful backup, and the recent
   * `backup_log` attempts **with their failure reasons**.
   *
   * Carries no refresh token and no client secret — only `hasClientSecret`.
   * The token never leaves the main process at all, the same discipline that
   * keeps `password_hash` out of `UserListRow`.
   */
  getBackupStatus: () => Promise<BackupStatusView>
  /** Owner-only (`settings:edit`) — stores the Google OAuth client. A blank secret leaves the stored one alone, since the screen never receives it to re-submit. */
  setDriveCredentials: (input: { clientId: string; clientSecret: string }) => Promise<void>
  /** Owner-only (`backup:run`) — opens Google's consent screen in the real browser and persists the resulting authorization. Resolves once the Owner has finished, or rejects if they decline or it times out. */
  connectDrive: () => Promise<void>
  /** Owner-only (`backup:run`) — forgets this machine's authorization and the stored client. The grant itself lives on until revoked in the Google account. */
  disconnectDrive: () => Promise<void>
  /** Owner-only (`settings:edit`) — when automatic backups run. */
  setBackupSchedule: (schedule: BackupSchedule) => Promise<BackupSchedule>
  /** Owner-only (`backup:run`) — the manual "Backup Now". Resolves with the outcome rather than rejecting on failure, so the panel can show the reason in place. */
  runBackupNow: () => Promise<RunBackupResult>
  /** Owner-only (`backup:restore`) — the snapshots in Drive, newest first, dated from their file names rather than Drive's upload times. */
  listRestorePoints: () => Promise<RestorePoint[]>
  /**
   * Owner-only (`backup:restore`) — **overwrites the local database** with a
   * chosen snapshot and restarts the app.
   *
   * Validates the download before touching anything and keeps a copy of the
   * database being replaced. Does not resolve on success: the app relaunches.
   */
  restoreFromBackup: (driveFileId: string) => Promise<void>
  /**
   * Owner-only (`retention:run`) — what the purge job **would** do, touching
   * nothing (PHASE12.md section 3).
   *
   * Includes `heldBack`: bills old enough to purge that no successful backup
   * has captured. The safeguard leaves those alone, and a count that keeps
   * climbing means Drive backups are failing — which is why it is on screen
   * rather than only in a log.
   */
  previewRetention: () => Promise<RetentionPreview>
  /**
   * Owner-only (`retention:run`) — turns the purge job on or off.
   *
   * Ships **off**. Enabling it is the decision to start deleting data
   * irreversibly, which is why it carries `retention:run` rather than
   * `settings:edit`.
   */
  setRetentionEnabled: (enabled: boolean) => Promise<boolean>
  /** Owner-only (`retention:run`) — runs the job now. Resolves with what it did, including a Drive-sweep failure that left the local half correctly done. */
  runRetention: () => Promise<RetentionRunResult>
  /** Owner-only (`retention:run`) — the purge audit trail. Holds no money and no customer, by design. */
  getPurgeLog: () => Promise<PurgeLogRow[]>
  /**
   * Owner-only (`report:view_all`) — writes **every sale still in the
   * database**, with its line items, to a CSV the Owner chooses
   * (PHASE12.md section 4).
   *
   * Exists so anything worth keeping can be taken out permanently before the
   * day-90 retention window closes on it, which is why it is a complete dump
   * with no date range rather than another Phase 11 report.
   *
   * Resolves `{saved: false}` when the save dialog is dismissed — a normal
   * choice, not an error.
   */
  exportSalesHistory: () => Promise<{
    saved: boolean
    filePath: string | null
    saleCount: number
    rowCount: number
  }>
  getWhatsAppState: () => Promise<WhatsAppState>
  /** Owner-only (assertPermission'd in main.ts) — starts/retries the WhatsApp Web connect attempt. */
  connectWhatsApp: () => Promise<void>
  /** Owner-only (assertPermission'd in main.ts) — logs out the current session and starts a fresh QR for re-linking. */
  logoutWhatsApp: () => Promise<void>
  /**
   * Owner-only (assertPermission'd in main.ts) — clears the *embedded
   * WhatsApp Web view's* own linked session, not the billing one. The two are
   * separate linked devices (see `WHATSAPP_WEB_PARTITION`), so this leaves
   * automatic bill sending untouched.
   */
  resetWhatsAppWebView: () => Promise<void>
  /** Subscribes to live status pushes from the main process; returns an unsubscribe function. */
  onWhatsAppState: (callback: (state: WhatsAppState) => void) => () => void
  /**
   * How many bills are still waiting to go out. Visible to both roles, like
   * the status badge itself: since 2026-08-24 printing no longer waits on
   * WhatsApp delivery, so this count is what keeps an undelivered bill from
   * going unnoticed.
   */
  getPendingBillCount: () => Promise<number>
  /** Subscribes to "the pending queue moved" pushes, emitted after an automatic retry run; returns an unsubscribe function. */
  onPendingBillsChanged: (callback: () => void) => () => void
  /** Owner-only (assertPermission'd in main.ts) — every bill sent to a customer, newest first, for the bill-delivery view. */
  getBillDeliveries: () => Promise<BillDeliveryRow[]>
  /**
   * Owner-only (assertPermission'd in main.ts) — retries a bill that didn't
   * go out, sending only to recipients still marked unsent so a copy that did
   * land can't be duplicated. Resolves with the refreshed delivery list.
   */
  resendBill: (saleId: number) => Promise<BillDeliveryRow[]>
  /** Subscribes to live delivery/read tick updates as they arrive from WhatsApp; returns an unsubscribe function. */
  onWhatsAppAck: (callback: (event: WhatsAppAckEvent) => void) => () => void
}
