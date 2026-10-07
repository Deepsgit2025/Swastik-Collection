import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ElectronApi, SafeUser, UnlockResult, UserListRow } from '../src/types/user.js'
import type { SalesmanListFilters, SalesmanRow } from '../src/types/salesman.js'
import type {
  CreatePartyInput,
  PartyDetail,
  PartyLedgerResult,
  PartyListFilters,
  PartyListRow,
  QuickAddPartyInput,
  UpdatePartyInput,
} from '../src/types/party.js'
import type { BarcodeLabelListFilters, BarcodeLabelRow, CreateBarcodeLabelInput } from '../src/types/barcodeLabel.js'
import type { CreateSaleInput, SaleRecord } from '../src/types/sale.js'
import type { RecordPaymentInput, RecordPaymentResult } from '../src/types/payment.js'
import type { ExpenseListFilters, ExpenseListRow, ExpenseRecord, LogExpenseInput } from '../src/types/expense.js'
import type { LabelSize, ShopSettings, ShopSettingsInput } from '../src/types/settings.js'
import type {
  BackupSchedule,
  BackupStatusView,
  RestorePoint,
  RunBackupResult,
} from '../src/types/backup.js'
import type { PurgeLogRow, RetentionPreview, RetentionRunResult } from '../src/types/retention.js'
import type {
  DailySalesReportData,
  DateRange,
  ExportCsvResult,
  OwnerDashboardData,
  PartyOutstandingReportData,
  SalesLedgerRow,
  SalesmanReportData,
  SalesmanSaleRow,
} from '../src/types/report.js'
import type { BillDeliveryRow, WhatsAppAckEvent, WhatsAppState } from '../src/types/whatsapp.js'

// None of these pass a `user`/role argument: the main process identifies the
// caller itself from the session it holds for this window, so there is nothing
// here for a modified renderer to forge (see electron/session.ts).
//
// The three auth methods are the only way that session changes, and none of
// them lets the renderer *name* who it becomes: `startSession` and
// `lockSession` take nothing at all, and `unlockOwner` takes a password that
// the main process checks against the database itself.
const api: ElectronApi = {
  startSession: (): Promise<SafeUser> => ipcRenderer.invoke('auth:start'),
  unlockOwner: (password: string): Promise<UnlockResult> => ipcRenderer.invoke('auth:unlock', password),
  lockSession: (): Promise<SafeUser> => ipcRenderer.invoke('auth:lock'),
  getParties: (filters?: PartyListFilters): Promise<PartyListRow[]> =>
    ipcRenderer.invoke('parties:list', filters),
  getPartyLedger: (partyId: number): Promise<PartyLedgerResult | null> =>
    ipcRenderer.invoke('parties:ledger', partyId),
  createParty: (data: CreatePartyInput): Promise<PartyDetail> => ipcRenderer.invoke('parties:create', data),
  quickAddParty: (data: QuickAddPartyInput): Promise<PartyDetail> => ipcRenderer.invoke('parties:quickAdd', data),
  updateParty: (id: number, data: UpdatePartyInput): Promise<PartyDetail> =>
    ipcRenderer.invoke('parties:update', id, data),
  deleteParty: (id: number): Promise<void> => ipcRenderer.invoke('parties:delete', id),
  getBarcodeLabels: (filters?: BarcodeLabelListFilters): Promise<BarcodeLabelRow[]> =>
    ipcRenderer.invoke('barcode:list', filters),
  createBarcodeLabel: (data: CreateBarcodeLabelInput): Promise<BarcodeLabelRow> =>
    ipcRenderer.invoke('barcode:create', data),
  createSale: (data: CreateSaleInput): Promise<SaleRecord> => ipcRenderer.invoke('sale:create', data),
  recordPayment: (data: RecordPaymentInput): Promise<RecordPaymentResult> =>
    ipcRenderer.invoke('payment:create', data),
  getExpenses: (filters?: ExpenseListFilters): Promise<ExpenseListRow[]> =>
    ipcRenderer.invoke('expense:list', filters),
  logExpense: (data: LogExpenseInput): Promise<ExpenseRecord> => ipcRenderer.invoke('expense:create', data),
  // Takes no range — the main process decides what "today" is, so a patched
  // renderer cannot widen the window. Its Salesman counterpart
  // (`dashboard:salesman`) was removed on 2026-08-27 with the salesman login.
  getOwnerDashboard: (): Promise<OwnerDashboardData> => ipcRenderer.invoke('dashboard:owner'),
  // Reports (PHASE11.md) — Owner-only, and unlike the two dashboard channels
  // above these *do* take a range, because a picker is the whole point. The
  // main process validates it before querying; the range is a window, never an
  // identity, so there is nothing here for a patched renderer to gain by
  // forging one beyond looking at a different set of days.
  getDailySalesReport: (range: DateRange): Promise<DailySalesReportData> =>
    ipcRenderer.invoke('reports:dailySales', range),
  getSalesmanReport: (range: DateRange): Promise<SalesmanReportData> =>
    ipcRenderer.invoke('reports:salesmanBreakdown', range),
  getSalesmanSales: (salesmanId: number | null, range: DateRange): Promise<SalesmanSaleRow[]> =>
    ipcRenderer.invoke('reports:salesmanSales', salesmanId, range),
  getSalesLedger: (range: DateRange): Promise<SalesLedgerRow[]> => ipcRenderer.invoke('reports:salesLedger', range),
  getPartyOutstandingReport: (): Promise<PartyOutstandingReportData> =>
    ipcRenderer.invoke('reports:partyOutstanding'),
  exportCsv: (defaultFileName: string, csvText: string): Promise<ExportCsvResult> =>
    ipcRenderer.invoke('reports:exportCsv', defaultFileName, csvText),
  printSale: (saleId: number): Promise<SaleRecord> => ipcRenderer.invoke('sale:print', saleId),
  usePrintOverride: (saleId: number): Promise<SaleRecord> => ipcRenderer.invoke('sale:printOverride', saleId),
  printPage: (): Promise<void> => ipcRenderer.invoke('print:page'),
  getLabelSize: (): Promise<LabelSize> => ipcRenderer.invoke('settings:getLabelSize'),
  setLabelSize: (size: LabelSize): Promise<LabelSize> => ipcRenderer.invoke('settings:setLabelSize', size),
  // Shop details + the Owner's WhatsApp number (PHASE12.md section 1). The read
  // is open to both roles because it is the bill header and a Salesman prints
  // bills; the write is Owner-only, enforced by `settings:edit` inside
  // `setShopSettings` rather than here — same split as label size above.
  getShopSettings: (): Promise<ShopSettings> => ipcRenderer.invoke('settings:getShop'),
  setShopSettings: (input: ShopSettingsInput): Promise<ShopSettings> =>
    ipcRenderer.invoke('settings:setShop', input),
  // Salesman names (2026-08-27), replacing Phase 12's salesman-login
  // management. The list is open to the counter — the sale screen needs it;
  // the three writes are Owner-only via `salesman:manage`. No delete channel
  // exists, deliberately: a salesman is soft-disabled, never removed, so the
  // `salesman_id` on every historical sale keeps resolving.
  getSalesmen: (filters?: SalesmanListFilters): Promise<SalesmanRow[]> =>
    ipcRenderer.invoke('salesmen:list', filters),
  createSalesman: (name: string): Promise<SalesmanRow> => ipcRenderer.invoke('salesmen:create', name),
  renameSalesman: (id: number, name: string): Promise<SalesmanRow> =>
    ipcRenderer.invoke('salesmen:rename', id, name),
  setSalesmanActive: (id: number, isActive: boolean): Promise<SalesmanRow> =>
    ipcRenderer.invoke('salesmen:setActive', id, isActive),
  // Owner-only (`user:manage`). The current password travels in and nothing
  // comes back but the row minus its hash — same discipline as everywhere else
  // here: secrets go one way only.
  changeOwnerPassword: (currentPassword: string, newPassword: string): Promise<UserListRow> =>
    ipcRenderer.invoke('users:changeOwnerPassword', currentPassword, newPassword),
  // Google Drive backup (PHASE12.md section 2) — all Owner-only via the
  // `backup:run`/`backup:restore` permissions that have been sitting unused in
  // the Phase 2 table since it was written. Nothing here carries a token or a
  // client secret in either direction: the secret only ever travels *in*, on
  // `setDriveCredentials`, and never comes back out.
  getBackupStatus: (): Promise<BackupStatusView> => ipcRenderer.invoke('backup:getStatus'),
  setDriveCredentials: (input: { clientId: string; clientSecret: string }): Promise<void> =>
    ipcRenderer.invoke('backup:setCredentials', input),
  connectDrive: (): Promise<void> => ipcRenderer.invoke('backup:connect'),
  disconnectDrive: (): Promise<void> => ipcRenderer.invoke('backup:disconnect'),
  setBackupSchedule: (schedule: BackupSchedule): Promise<BackupSchedule> =>
    ipcRenderer.invoke('backup:setSchedule', schedule),
  runBackupNow: (): Promise<RunBackupResult> => ipcRenderer.invoke('backup:runNow'),
  listRestorePoints: (): Promise<RestorePoint[]> => ipcRenderer.invoke('backup:listRestorePoints'),
  restoreFromBackup: (driveFileId: string): Promise<void> =>
    ipcRenderer.invoke('backup:restore', driveFileId),
  // The retention/purge job (PHASE12.md section 3), all Owner-only via the new
  // `retention:run` permission. `previewRetention` is read-only by contract —
  // it is what lets an irreversible delete be inspected before it happens.
  previewRetention: (): Promise<RetentionPreview> => ipcRenderer.invoke('retention:preview'),
  setRetentionEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('retention:setEnabled', enabled),
  runRetention: (): Promise<RetentionRunResult> => ipcRenderer.invoke('retention:run'),
  getPurgeLog: (): Promise<PurgeLogRow[]> => ipcRenderer.invoke('retention:purgeLog'),
  // Full sales history (PHASE12.md section 4). Built and saved entirely in the
  // main process — the renderer asks for it and is told what was written.
  exportSalesHistory: (): Promise<{
    saved: boolean
    filePath: string | null
    saleCount: number
    rowCount: number
  }> => ipcRenderer.invoke('sales:exportHistory'),
  getWhatsAppState: (): Promise<WhatsAppState> => ipcRenderer.invoke('whatsapp:getState'),
  connectWhatsApp: (): Promise<void> => ipcRenderer.invoke('whatsapp:connect'),
  logoutWhatsApp: (): Promise<void> => ipcRenderer.invoke('whatsapp:logout'),
  resetWhatsAppWebView: (): Promise<void> => ipcRenderer.invoke('whatsapp:resetWebView'),
  onWhatsAppState: (callback: (state: WhatsAppState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: WhatsAppState) => callback(state)
    ipcRenderer.on('whatsapp:state', listener)
    return () => ipcRenderer.removeListener('whatsapp:state', listener)
  },
  /** Bills still waiting to go out — the count beside the status badge, which replaced the blocking print gate. */
  getPendingBillCount: (): Promise<number> => ipcRenderer.invoke('whatsapp:pendingCount'),
  /** Fired after an automatic retry run, so the count refreshes without polling. */
  onPendingBillsChanged: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('whatsapp:pendingChanged', listener)
    return () => ipcRenderer.removeListener('whatsapp:pendingChanged', listener)
  },
  getBillDeliveries: (): Promise<BillDeliveryRow[]> => ipcRenderer.invoke('whatsapp:billDeliveries'),
  resendBill: (saleId: number): Promise<BillDeliveryRow[]> => ipcRenderer.invoke('whatsapp:resendBill', saleId),
  onWhatsAppAck: (callback: (event: WhatsAppAckEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, ack: WhatsAppAckEvent) => callback(ack)
    ipcRenderer.on('whatsapp:ack', listener)
    return () => ipcRenderer.removeListener('whatsapp:ack', listener)
  },
}

contextBridge.exposeInMainWorld('api', api)
