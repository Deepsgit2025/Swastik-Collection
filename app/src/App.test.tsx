import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App.tsx'
import type { SafeUser } from './types/user.ts'
import type { SalesmanRow } from './types/salesman.ts'
import type { BarcodeLabelRow } from './types/barcodeLabel.ts'
import type { PartyListRow } from './types/party.ts'
import type { SaleRecord } from './types/sale.ts'
import type { ExpenseListRow, ExpenseRecord } from './types/expense.ts'
import type {
  DailySalesReportData,
  OwnerDashboardData,
  PartyOutstandingReportData,
  SalesLedgerRow,
  SalesmanReportData,
  SalesmanSaleRow,
} from './types/report.ts'
import type { ShopSettings } from './types/settings.ts'
import type { BackupStatusView, RestorePoint } from './types/backup.ts'
import type { PurgeLogRow, RetentionPreview } from './types/retention.ts'
import { todayIsoDate } from './lib/expenseMath.ts'
import { thisMonthRange } from './lib/dateRange.ts'

const OWNER: SafeUser = { id: 1, username: 'owner', role: 'owner', full_name: 'Shop Owner' }
/**
 * The session an un-unlocked window runs as (2026-08-27 — nobody logs in).
 * Role `salesman`, which is what makes the Phase 2 PERMISSIONS table the
 * definition of what the counter may do.
 */
const COUNTER: SafeUser = { id: 2, username: '__counter__', role: 'salesman', full_name: 'Counter' }

const TODAY_RANGE = { from: '2026-08-24', to: '2026-08-24' }

/**
 * Figures picked so every derived number on screen is distinguishable from
 * every other one — a Cash card that read the same as the UPI card would pass
 * a test that had them swapped.
 */
const OWNER_DASHBOARD: OwnerDashboardData = {
  range: TODAY_RANGE,
  generatedAt: '2026-08-24 09:42:00',
  summary: {
    saleCount: 3,
    salesTotal: 4400,
    cashFromSales: 1550,
    upiFromSales: 1850,
    creditIssued: 1000,
    cashFromPayments: 250,
    upiFromPayments: 400,
    creditCollected: 650,
    cashCollected: 1800,
    upiCollected: 2250,
    totalCollected: 4050,
  },
  salesmanBreakdown: [
    {
      salesmanId: 2,
      salesmanName: 'Anil Salesman',
      saleCount: 2,
      total: 3250,
      cashTotal: 1200,
      upiTotal: 1100,
      creditTotal: 950,
    },
    {
      salesmanId: 3,
      salesmanName: 'Bhavna Salesman',
      saleCount: 1,
      total: 1150,
      cashTotal: 350,
      upiTotal: 750,
      creditTotal: 50,
    },
  ],
  outstandingCredit: 12750,
  expenseTotal: 830,
}

/**
 * Reports fixtures (PHASE11.md). `REPORT_RANGE` is a *multi-day* range on
 * purpose — the reports differ from the dashboard precisely in not being
 * today, and a single-day fixture would let a screen that ignored its picker
 * pass.
 */
const REPORT_RANGE = { from: '2026-08-01', to: '2026-08-24' }

const DAILY_SALES_REPORT: DailySalesReportData = {
  range: REPORT_RANGE,
  generatedAt: '2026-08-24 09:42:00',
  summary: {
    saleCount: 9,
    salesTotal: 18400,
    cashFromSales: 6550,
    upiFromSales: 7850,
    creditIssued: 4000,
    cashFromPayments: 1250,
    upiFromPayments: 900,
    creditCollected: 2150,
    cashCollected: 7800,
    upiCollected: 8750,
    totalCollected: 16550,
  },
  // Null: nothing has been purged, so the retention note must stay hidden.
  cashRetentionCutoff: null,
}

const SALESMAN_REPORT: SalesmanReportData = {
  cashRetentionCutoff: null,
  range: REPORT_RANGE,
  generatedAt: '2026-08-24 09:42:00',
  rows: [
    {
      salesmanId: 2,
      salesmanName: 'Anil Salesman',
      saleCount: 6,
      total: 13250,
      cashTotal: 5200,
      upiTotal: 4100,
      creditTotal: 3950,
    },
    {
      salesmanId: 3,
      salesmanName: 'Bhavna Salesman',
      saleCount: 3,
      total: 5150,
      cashTotal: 1350,
      upiTotal: 3750,
      creditTotal: 50,
    },
  ],
}

const SALESMAN_SALES: SalesmanSaleRow[] = [
  {
    saleId: 41,
    createdAt: '2026-08-24 06:15:00',
    partyName: 'Ramesh Textiles',
    itemCount: 3,
    paymentMode: 'split',
    grandTotal: 900,
    cashAmount: 400,
    upiAmount: 200,
    creditAmount: 300,
  },
  {
    saleId: 38,
    createdAt: '2026-08-22 11:05:00',
    partyName: null,
    itemCount: 1,
    paymentMode: 'cash',
    grandTotal: 250,
    cashAmount: 250,
    upiAmount: 0,
    creditAmount: 0,
  },
]

/**
 * `outstandingTotal` is deliberately **not** the sum of `rows` — the advance
 * row is negative and positives-only is what `getOutstandingCreditTotal`
 * reports (12400 + 850 = 13250). A fixture where the two happened to agree
 * would pass whether or not the screen got this right.
 */
const PARTY_OUTSTANDING_REPORT: PartyOutstandingReportData = {
  generatedAt: '2026-08-24 09:42:00',
  rows: [
    { partyId: 1, partyName: 'Ramesh Textiles', phone: '9876500001', balance: 12400 },
    { partyId: 2, partyName: 'Meena Fabrics', phone: null, balance: 850 },
    { partyId: 3, partyName: 'Kiran Stores', phone: '9876500003', balance: -1200 },
  ],
  outstandingTotal: 13250,
}

/**
 * Settings fixtures (PHASE12.md section 1). `SHOP_SETTINGS` is deliberately not
 * the real shop's values — a header still reading the deleted `TEMP_*`
 * constants would coincidentally pass against those, and fail against these.
 */
const SHOP_SETTINGS: ShopSettings = {
  shopName: 'Fixture Collections',
  shopAddress: '9 Fixture Lane, Testville',
  shopPhone: '9000000001',
  ownerWhatsappNumber: '919000000002',
}

/** The `salesmen` rows the Settings panel administers — names, no logins. */
const SALESMEN: SalesmanRow[] = [
  { id: 1, name: 'Anil Salesman', is_active: 1, legacy_user_id: 2, created_at: '2026-01-02 09:00:00' },
  { id: 2, name: 'Bhavna Salesman', is_active: 1, legacy_user_id: null, created_at: '2026-02-10 09:00:00' },
  { id: 3, name: 'Old Staff', is_active: 0, legacy_user_id: 3, created_at: '2026-01-05 09:00:00' },
]

/** Every bill in the range, for the Sales module's table. */
const SALES_LEDGER: SalesLedgerRow[] = [
  {
    saleId: 41,
    createdAt: '2026-08-24 06:15:00',
    partyName: 'Ramesh Textiles',
    salesmanId: 1,
    salesmanName: 'Anil Salesman',
    paymentMode: 'split',
    grandTotal: 900,
  },
  {
    saleId: 40,
    createdAt: '2026-08-24 05:00:00',
    partyName: null,
    salesmanId: 2,
    salesmanName: 'Bhavna Salesman',
    paymentMode: 'cash',
    grandTotal: 1500,
  },
  {
    saleId: 39,
    createdAt: '2026-08-24 04:00:00',
    partyName: 'Sunita Fabrics',
    salesmanId: null,
    salesmanName: 'Unassigned',
    paymentMode: 'upi',
    grandTotal: 250,
  },
]

/**
 * Backup fixtures (PHASE12.md section 2). `recentAttempts` deliberately holds a
 * failure **with a reason**: a panel that renders only successes would hide
 * exactly the run of quiet failures `backup_log.error` exists to surface.
 */
const BACKUP_STATUS: BackupStatusView = {
  clientId: '1234-test.apps.googleusercontent.com',
  hasClientSecret: true,
  connected: true,
  connectedEmail: 'shopowner@example.com',
  schedule: { timeOfDay: '21:00', onAppClose: true },
  lastSuccessAt: '2026-08-25 15:30:00',
  nextRunAt: '2026-08-26T15:30:00.000Z',
  recentAttempts: [
    {
      id: 2,
      status: 'success',
      drive_file_id: 'drive-file-2',
      triggered_by: 'scheduled',
      error: null,
      file_name: 'swastik-backup-2026-08-25-2100.db',
      size_bytes: 81920,
      created_at: '2026-08-25 15:30:00',
    },
    {
      id: 1,
      status: 'failed',
      drive_file_id: null,
      triggered_by: 'manual',
      error: 'Uploading the backup to Drive failed (HTTP 403): Rate Limit Exceeded',
      file_name: 'swastik-backup-2026-08-24-2100.db',
      size_bytes: null,
      created_at: '2026-08-24 15:30:00',
    },
  ],
}

const RESTORE_POINTS: RestorePoint[] = [
  {
    driveFileId: 'drive-file-2',
    fileName: 'swastik-backup-2026-08-25-2100.db',
    takenAt: '2026-08-25 21:00',
    sizeBytes: 81920,
  },
  {
    driveFileId: 'drive-file-0',
    fileName: 'swastik-backup-2026-08-20-2100.db',
    takenAt: '2026-08-20 21:00',
    sizeBytes: 76000,
  },
]

/**
 * Retention fixtures (PHASE12.md section 3). `enabled: false` is the shipped
 * state and the default here on purpose — a test suite whose baseline had the
 * destructive job switched on would be asserting the wrong world.
 *
 * `heldBack` is non-empty because that is the safeguard's visible output: bills
 * old enough to remove that no successful backup has captured.
 */
const RETENTION_PREVIEW: RetentionPreview = {
  enabled: false,
  lastRunAt: null,
  dueForLocalPurge: [
    { id: 11, created_at: '2026-07-01 10:00:00', purge_at: '2026-09-29 10:00:00' },
    { id: 12, created_at: '2026-07-02 10:00:00', purge_at: '2026-09-30 10:00:00' },
  ],
  heldBack: [{ id: 21, created_at: '2026-07-20 10:00:00', purge_at: '2026-10-18 10:00:00' }],
  creditDueForLocalPurge: [],
  creditHeldBack: [],
  overdueNeverBackedUp: [],
  snapshotsToDelete: [
    { driveFileId: 'old-snap', fileName: 'swastik-backup-2026-06-01-2100.db', takenAt: '2026-06-01 21:00' },
  ],
}

const PURGE_LOG: PurgeLogRow[] = [
  {
    id: 2,
    action: 'drive_snapshot_delete',
    sale_id: null,
    sale_created_at: null,
    drive_file_id: 'gone-snap',
    file_name: 'swastik-backup-2026-05-20-2100.db',
    created_at: '2026-08-20 15:30:00',
  },
  {
    id: 1,
    action: 'local_purge',
    sale_id: 7,
    sale_created_at: '2026-06-15 11:00:00',
    drive_file_id: null,
    file_name: null,
    created_at: '2026-08-19 15:30:00',
  },
]

/**
 * The whole preload surface, stubbed.
 *
 * `unlockOwner` succeeds by default: most cases below are about what an Owner
 * sees once they are past the prompt, not about the prompt itself, and the
 * cases that *are* about it override this. In the real app this call is what
 * changes the main process's session — here it only changes what `AuthContext`
 * holds, which is why the tests that matter for access control live in
 * `src/db/*.test.ts` against `assertPermission`, not here.
 */
function mockApi(parties: PartyListRow[] = []): void {
  window.api = {
    startSession: vi.fn().mockResolvedValue(COUNTER),
    unlockOwner: vi.fn().mockResolvedValue({ ok: true, user: OWNER }),
    lockSession: vi.fn().mockResolvedValue(COUNTER),
    getParties: vi.fn().mockResolvedValue(parties),
    getPartyLedger: vi.fn().mockResolvedValue(null),
    createParty: vi.fn(),
    quickAddParty: vi.fn(),
    updateParty: vi.fn(),
    deleteParty: vi.fn(),
    getBarcodeLabels: vi.fn().mockResolvedValue([]),
    createBarcodeLabel: vi.fn(),
    createSale: vi.fn(),
    recordPayment: vi.fn(),
    getExpenses: vi.fn().mockResolvedValue([]),
    logExpense: vi.fn(),
    getOwnerDashboard: vi.fn().mockResolvedValue(OWNER_DASHBOARD),
    getDailySalesReport: vi.fn().mockResolvedValue(DAILY_SALES_REPORT),
    getSalesmanReport: vi.fn().mockResolvedValue(SALESMAN_REPORT),
    getSalesmanSales: vi.fn().mockResolvedValue(SALESMAN_SALES),
    getSalesLedger: vi.fn().mockResolvedValue(SALES_LEDGER),
    getPartyOutstandingReport: vi.fn().mockResolvedValue(PARTY_OUTSTANDING_REPORT),
    exportCsv: vi.fn().mockResolvedValue({ saved: true, filePath: 'C:\\Users\\owner\\report.csv' }),
    printSale: vi.fn(),
    usePrintOverride: vi.fn(),
    printPage: vi.fn(),
    getLabelSize: vi.fn().mockResolvedValue({ widthMm: 50, heightMm: 25 }),
    setLabelSize: vi.fn(),
    getShopSettings: vi.fn().mockResolvedValue(SHOP_SETTINGS),
    setShopSettings: vi.fn().mockImplementation((input) => Promise.resolve(input)),
    getSalesmen: vi.fn().mockResolvedValue(SALESMEN),
    createSalesman: vi.fn(),
    renameSalesman: vi.fn(),
    setSalesmanActive: vi.fn(),
    changeOwnerPassword: vi.fn(),
    getBackupStatus: vi.fn().mockResolvedValue(BACKUP_STATUS),
    setDriveCredentials: vi.fn().mockResolvedValue(undefined),
    connectDrive: vi.fn().mockResolvedValue(undefined),
    disconnectDrive: vi.fn().mockResolvedValue(undefined),
    setBackupSchedule: vi.fn().mockImplementation((schedule) => Promise.resolve(schedule)),
    runBackupNow: vi.fn(),
    listRestorePoints: vi.fn().mockResolvedValue(RESTORE_POINTS),
    restoreFromBackup: vi.fn(),
    previewRetention: vi.fn().mockResolvedValue(RETENTION_PREVIEW),
    setRetentionEnabled: vi.fn().mockImplementation((enabled) => Promise.resolve(enabled)),
    runRetention: vi.fn(),
    getPurgeLog: vi.fn().mockResolvedValue(PURGE_LOG),
    exportSalesHistory: vi
      .fn()
      .mockResolvedValue({ saved: true, filePath: 'C:\Users\owner\history.csv', saleCount: 22, rowCount: 31 }),
    getWhatsAppState: vi
      .fn()
      .mockResolvedValue({ status: 'disconnected', qrDataUrl: null, connectedNumber: null, lastError: null }),
    connectWhatsApp: vi.fn(),
    logoutWhatsApp: vi.fn(),
    resetWhatsAppWebView: vi.fn(),
    resendBill: vi.fn(),
    onWhatsAppState: vi.fn().mockReturnValue(() => {}),
    getBillDeliveries: vi.fn().mockResolvedValue([]),
    onWhatsAppAck: vi.fn().mockReturnValue(() => {}),
    getPendingBillCount: vi.fn().mockResolvedValue(0),
    onPendingBillsChanged: vi.fn().mockReturnValue(() => {}),
  }
}

/**
 * Launches the app the way the shop does: no login, straight to the till
 * (2026-08-27).
 *
 * The wait is not optional — `SessionGate` renders nothing until
 * `startSession()` answers, so a synchronous query here would find an empty
 * document rather than a slow one.
 */
async function openApp(parties: PartyListRow[] = []) {
  mockApi(parties)
  render(<App />)
  await screen.findByRole('link', { name: /new sale/i })
}

/** Fills in the Owner password prompt currently on screen. */
async function unlock(password = 'owner123') {
  await userEvent.type(await screen.findByLabelText(/^owner password$/i), password)
  await userEvent.click(screen.getByRole('button', { name: /unlock/i }))
}

/** Simulates a user editing the address bar / hash by hand, mid-session. */
function editHashTo(hash: string) {
  window.location.hash = hash
}

beforeEach(() => {
  window.location.hash = ''
})

/**
 * Open screens, Owner password on actions (client decision, 2026-09-19:
 * "remove the Owner lock, but make sure no one can delete an entry without the
 * Owner password"), replacing the route-lock suite that stood here from
 * 2026-08-27.
 *
 * **These cases test the asking, not the enforcing.** `unlockOwner` is mocked,
 * so nothing below proves anyone is kept out - that proof lives in
 * `src/db/*.test.ts`, where every write asserts a permission against the main
 * process's own session. What is checked here is that every screen opens with
 * no prompt, that the prompt appears at the moment an edit or a delete is
 * clicked, that a wrong password or Cancel leaves the action undone, and that
 * the window drops back to the counter afterwards.
 */
describe('open screens, with the Owner password on every edit and delete', () => {
  it('opens straight into billing with no login form', async () => {
    await openApp()

    expect(await screen.findByPlaceholderText(/scan or search by barcode/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/owner password/i)).not.toBeInTheDocument()
  })

  it('establishes the counter session before anything renders', async () => {
    await openApp()

    // Without this the first screen would fire its effects before the main
    // process had a session for this window, and every one would reject with
    // "Not authenticated".
    expect(window.api.startSession).toHaveBeenCalled()
  })

  it.each([
    ['#/dashboard', /today at a glance/i],
    ['#/reports', /^reports$/i],
    ['#/settings', /^settings$/i],
    ['#/whatsapp', /^whatsapp setup$/i],
    ['#/sales', /^sales$/i],
    ['#/parties', /^parties$/i],
  ])('opens %s with no password, as the counter', async (hash, heading) => {
    await openApp()

    editHashTo(hash)

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
    expect(screen.queryByLabelText(/owner password/i)).not.toBeInTheDocument()
    // Nothing on the way in raised the window to the Owner.
    expect(window.api.unlockOwner).not.toHaveBeenCalled()
  })

  it.each([['#/sale/new'], ['#/payment-in'], ['#/expenses'], ['#/barcode-generator']])(
    'opens %s at the counter with no password',
    async (hash) => {
      await openApp()

      editHashTo(hash)

      await waitFor(() => expect(screen.queryByLabelText(/owner password/i)).not.toBeInTheDocument())
    },
  )

  it('shows no padlock beside any sidebar entry', async () => {
    await openApp()

    expect(screen.queryByLabelText(/locked/i)).not.toBeInTheDocument()
  })

  it('has no Logout button, because there is no session to end', async () => {
    await openApp()

    expect(screen.queryByRole('button', { name: /logout/i })).not.toBeInTheDocument()
  })

  it('sends an unknown hash to the till rather than a dead end', async () => {
    window.location.hash = '#/salesman'
    mockApi()

    render(<App />)

    expect(await screen.findByPlaceholderText(/scan or search by barcode/i)).toBeInTheDocument()
  })

  describe('an edit or delete', () => {
    const SAMPLE_PARTY: PartyListRow = {
      id: 1,
      name: 'Sunita Fabrics',
      phone: '9876500002',
      balance: 4500,
      created_at: '2026-01-01 00:00:00',
    }

    /** Opens Parties and confirms the existing "Delete party?" dialog, which is what leads to the password. */
    async function confirmDelete() {
      await screen.findByText('Sunita Fabrics')
      await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
      const confirmation = (await screen.findByRole('heading', { name: /delete party\?/i })).closest('div')!
      await userEvent.click(within(confirmation).getByRole('button', { name: /^delete$/i }))
    }

    async function openPartiesAndConfirmDelete() {
      await openApp([SAMPLE_PARTY])
      editHashTo('#/parties')
      await confirmDelete()
    }

    it('asks for the Owner password when Delete is confirmed, and does nothing until it is given', async () => {
      await openPartiesAndConfirmDelete()

      expect(await screen.findByLabelText(/owner password/i)).toBeInTheDocument()
      expect(window.api.deleteParty).not.toHaveBeenCalled()
    })

    it('runs the action once the right password is given, then drops back to the counter', async () => {
      await openPartiesAndConfirmDelete()

      await unlock()

      await waitFor(() => expect(window.api.deleteParty).toHaveBeenCalledWith(1))
      expect(window.api.unlockOwner).toHaveBeenCalledWith('owner123')
      await waitFor(() => expect(window.api.lockSession).toHaveBeenCalled())
      await waitFor(() => expect(screen.queryByLabelText(/owner password/i)).not.toBeInTheDocument())
    })

    it('leaves the action undone on a wrong password', async () => {
      await openApp([SAMPLE_PARTY])
      window.api.unlockOwner = vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'That password is not correct.', retryAfterMs: 0 })
      editHashTo('#/parties')
      await confirmDelete()

      await unlock('wrong')

      expect(await screen.findByRole('alert')).toHaveTextContent(/not correct/i)
      expect(window.api.deleteParty).not.toHaveBeenCalled()
    })

    it('says how long to wait when the throttle asks it to', async () => {
      await openApp([SAMPLE_PARTY])
      window.api.unlockOwner = vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'That password is not correct.', retryAfterMs: 3000 })
      editHashTo('#/parties')
      await confirmDelete()

      await unlock('wrong')

      expect(await screen.findByRole('button', { name: /wait 3s/i })).toBeDisabled()
    })

    it('does nothing when the password prompt is cancelled', async () => {
      await openPartiesAndConfirmDelete()
      await screen.findByLabelText(/owner password/i)

      const prompt = screen.getByLabelText(/owner password/i).closest('form')!
      await userEvent.click(within(prompt).getByRole('button', { name: /^cancel$/i }))

      expect(window.api.deleteParty).not.toHaveBeenCalled()
      expect(window.api.unlockOwner).not.toHaveBeenCalled()
      expect(screen.queryByLabelText(/owner password/i)).not.toBeInTheDocument()
    })

    it('says on screen while Owner access is being held', async () => {
      // Hold the action open so the elevated window is observable.
      let release: () => void = () => {}
      await openApp([SAMPLE_PARTY])
      window.api.deleteParty = vi.fn().mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
      editHashTo('#/parties')
      await confirmDelete()

      await unlock()

      expect(await screen.findByText(/owner access/i)).toBeInTheDocument()
      release()
      await waitFor(() => expect(window.api.lockSession).toHaveBeenCalled())
    })
  })
})

describe('Party List — add is open, edit and delete ask for the Owner password', () => {
  const SAMPLE_PARTY: PartyListRow = {
    id: 1,
    name: 'Sunita Fabrics',
    phone: '9876500002',
    balance: 4500,
    created_at: '2026-01-01 00:00:00',
  }

  it('shows the counter the list, an Add Party button and per-row Edit/Delete controls', async () => {
    await openApp([SAMPLE_PARTY])
    editHashTo('#/parties')

    expect(await screen.findByText('Sunita Fabrics')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /\+ add party/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })

  it('opens the edit form freely but asks for the password only when Save Changes is clicked', async () => {
    await openApp([SAMPLE_PARTY])
    window.api.getPartyLedger = vi.fn().mockResolvedValue({
      party: { ...SAMPLE_PARTY, address: 'FC Road', created_by_user_id: 1 },
      entries: [],
    })
    window.api.updateParty = vi.fn().mockResolvedValue({ ...SAMPLE_PARTY, address: 'FC Road' })
    editHashTo('#/parties')
    await screen.findByText('Sunita Fabrics')

    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    await screen.findByRole('heading', { name: /edit party/i })
    expect(screen.queryByLabelText(/owner password/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(await screen.findByLabelText(/owner password/i)).toBeInTheDocument()
    expect(window.api.updateParty).not.toHaveBeenCalled()

    await unlock()
    await waitFor(() => expect(window.api.updateParty).toHaveBeenCalled())
  })

  it('adds a party without any password, since party:create was always open to the counter', async () => {
    await openApp([SAMPLE_PARTY])
    window.api.createParty = vi.fn().mockResolvedValue({ ...SAMPLE_PARTY, id: 2, name: 'New Party' })
    editHashTo('#/parties')
    await screen.findByText('Sunita Fabrics')

    await userEvent.click(screen.getByRole('button', { name: /\+ add party/i }))
    await userEvent.type(await screen.findByLabelText(/^name$/i), 'New Party')
    await userEvent.click(screen.getByRole('button', { name: /^add party$/i }))

    await waitFor(() => expect(window.api.createParty).toHaveBeenCalled())
    expect(window.api.unlockOwner).not.toHaveBeenCalled()
  })
})

describe('New Sale screen (PHASE5.md section 1, discount redesigned as a single bill-level field)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function addManualItem(name: string) {
    await userEvent.type(await screen.findByPlaceholderText(/scan or search by barcode, item name/i), name)
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`add "${name}" as a new item`, 'i') }))
  }

  /** The cart grid's own [quantity, unit price] spinbuttons, scoped away from the bill-level Discount/payment fields that live in the right panel. */
  function cartQtyAndPriceInputs() {
    const [quantity, unitPrice] = within(screen.getByRole('table')).getAllByRole('spinbutton')
    return { quantity, unitPrice }
  }

  function makeSaleRecord(overrides: Partial<SaleRecord> = {}): SaleRecord {
    return {
      id: 90,
      party_id: null,
      salesman_user_id: COUNTER.id,
      salesman_id: 1,
      payment_mode: 'cash',
      cash_amount: 300,
      upi_amount: 0,
      credit_amount: 0,
      subtotal: 300,
      total_discount: 0,
      grand_total: 300,
      whatsapp_customer_sent: 0,
      whatsapp_owner_sent: 0,
      printed: 0,
      print_override_used: 0,
      is_cash_bill: 1,
      archived_local: 0,
      purge_at: '2026-11-20 00:00:00',
      created_at: '2026-08-23 00:00:00',
      items: [],
      ...overrides,
    }
  }

  async function completeASale(sale: SaleRecord) {
    window.api.createSale = vi.fn().mockResolvedValue(sale)
    await addManualItem('Print-Gate Test Item')
    const { unitPrice } = cartQtyAndPriceInputs()
    await userEvent.clear(unitPrice)
    await userEvent.type(unitPrice, String(sale.grand_total))
    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }))
    await waitFor(() => expect(window.api.createSale).toHaveBeenCalledTimes(1))
  }

  describe('the Salesman box (typed, with suggestions — 2026-09-19)', () => {
    it('is a text box that suggests the active salesmen rather than a fixed dropdown', async () => {
      await openApp()
      editHashTo('#/sale/new')

      const box = await screen.findByLabelText(/^salesman$/i)
      expect(box.tagName).toBe('INPUT')
      expect(box).toHaveAttribute('list', 'salesman-names')
      expect(box).toHaveValue('')
      // Suggestions come from the salesmen list, and are only suggestions.
      await waitFor(() => expect(document.querySelectorAll('#salesman-names option').length).toBeGreaterThan(0))
    })

    it('sends the typed name with the sale, including one that is not in the list yet', async () => {
      await openApp()
      editHashTo('#/sale/new')
      await userEvent.type(await screen.findByLabelText(/^salesman$/i), '  Brand New Name ')

      await completeASale(makeSaleRecord())

      expect(window.api.createSale).toHaveBeenCalledWith(expect.objectContaining({ salesmanName: 'Brand New Name' }))
    })

    it('sends no salesman at all when the box is left empty', async () => {
      await openApp()
      editHashTo('#/sale/new')
      await screen.findByLabelText(/^salesman$/i)

      await completeASale(makeSaleRecord())

      expect(window.api.createSale).toHaveBeenCalledWith(expect.objectContaining({ salesmanName: null }))
    })
  })

  it('adds a manually-entered item, lets price be edited in the cart, and blocks a bill-level discount above the subtotal', async () => {
    await openApp()
    editHashTo('#/sale/new')

    await addManualItem('Loose Blouse Piece')

    const { unitPrice } = cartQtyAndPriceInputs()
    await userEvent.clear(unitPrice)
    await userEvent.type(unitPrice, '100')

    const discountInput = screen.getByLabelText(/discount/i)
    await userEvent.clear(discountInput)
    await userEvent.type(discountInput, '150')

    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot exceed the subtotal/i)
    expect(window.api.createSale).not.toHaveBeenCalled()
  })

  it('requires a party before a pure Credit sale can be saved', async () => {
    await openApp()
    editHashTo('#/sale/new')

    await addManualItem('Silk Saree')
    const { unitPrice } = cartQtyAndPriceInputs()
    await userEvent.clear(unitPrice)
    await userEvent.type(unitPrice, '500')

    await userEvent.selectOptions(screen.getByLabelText(/payment mode/i), 'credit')
    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/party is required/i)
    expect(window.api.createSale).not.toHaveBeenCalled()
  })

  it('blocks a Split sale whose Cash + UPI + Credit does not add up to the grand total', async () => {
    await openApp()
    editHashTo('#/sale/new')

    await addManualItem('Cotton Kurta')
    const { unitPrice } = cartQtyAndPriceInputs()
    await userEvent.clear(unitPrice)
    await userEvent.type(unitPrice, '800')

    await userEvent.selectOptions(screen.getByLabelText(/payment mode/i), 'split')

    const cashInput = screen.getByLabelText(/cash amount/i)
    const upiInput = screen.getByLabelText(/upi amount/i)
    await userEvent.clear(cashInput)
    await userEvent.type(cashInput, '500')
    await userEvent.clear(upiInput)
    await userEvent.type(upiInput, '200') // 500 + 200 = 700, grand total is 800 — deliberately short

    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/must exactly equal the grand total/i)
    expect(window.api.createSale).not.toHaveBeenCalled()
  })

  it('saves a valid cash sale end-to-end, showing a confirmation and clearing the cart', async () => {
    await openApp()
    editHashTo('#/sale/new')

    const CREATED: SaleRecord = {
      id: 55,
      party_id: null,
      salesman_user_id: COUNTER.id,
      salesman_id: 1,
      payment_mode: 'cash',
      cash_amount: 300,
      upi_amount: 0,
      credit_amount: 0,
      subtotal: 300,
      total_discount: 0,
      grand_total: 300,
      whatsapp_customer_sent: 0,
      whatsapp_owner_sent: 0,
      printed: 0,
      print_override_used: 0,
      is_cash_bill: 1,
      archived_local: 0,
      purge_at: '2026-11-20 00:00:00',
      created_at: '2026-08-22 00:00:00',
      items: [],
    }
    window.api.createSale = vi.fn().mockResolvedValue(CREATED)

    await addManualItem('Dupatta')
    const { unitPrice } = cartQtyAndPriceInputs()
    await userEvent.clear(unitPrice)
    await userEvent.type(unitPrice, '300')

    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }))

    await waitFor(() => expect(window.api.createSale).toHaveBeenCalledTimes(1))
    expect(window.api.createSale).toHaveBeenCalledWith(
      expect.objectContaining({
        partyId: null,
        discount: 0,
        paymentMode: 'cash',
        cashAmount: 300,
        upiAmount: 0,
        creditAmount: 0,
        items: [expect.objectContaining({ itemName: 'Dupatta', quantity: 1, unitPrice: 300 })],
      }),
    )

    expect(await screen.findByRole('status')).toHaveTextContent('Sale #55 saved')
    expect(screen.getByText(/scan a barcode or search for an item/i)).toBeInTheDocument()
  })

  it('reduces the grand total by the bill-level discount, without touching any line price', async () => {
    await openApp()
    editHashTo('#/sale/new')

    await addManualItem('Cotton Saree')
    const { unitPrice } = cartQtyAndPriceInputs()
    await userEvent.clear(unitPrice)
    await userEvent.type(unitPrice, '1000')

    const discountInput = screen.getByLabelText(/discount/i)
    await userEvent.clear(discountInput)
    await userEvent.type(discountInput, '100')

    await userEvent.click(screen.getByRole('button', { name: /full breakup/i }))

    expect(await screen.findByText(/grand total/i)).toBeInTheDocument()
    expect(window.api.createSale).not.toHaveBeenCalled() // just checking the live breakup, not saving yet
  })

  it('adds a cart line when a known barcode is scanned via the global scanner hook', async () => {
    let currentTime = 0
    vi.spyOn(performance, 'now').mockImplementation(() => currentTime)

    await openApp()
    editHashTo('#/sale/new')

    const SCANNED_LABEL: BarcodeLabelRow = {
      id: 1,
      item_name: 'Cotton Saree',
      price: 1200,
      barcode_value: 'SC12345678',
      header: null,
      line1: null,
      line2: null,
      line3: null,
      line4: null,
      created_by_user_id: OWNER.id,
      created_at: '2026-01-01 00:00:00',
    }
    window.api.getBarcodeLabels = vi.fn().mockResolvedValue([SCANNED_LABEL])

    await screen.findByText(/scan a barcode or search for an item/i)

    const code = SCANNED_LABEL.barcode_value
    currentTime += 1
    fireEvent.keyDown(window, { key: code[0] })
    for (const ch of code.slice(1)) {
      currentTime += 10
      fireEvent.keyDown(window, { key: ch })
    }
    currentTime += 10
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(await screen.findByText('Cotton Saree')).toBeInTheDocument()
    expect(screen.getByText(code)).toBeInTheDocument()
  })

  it('defaults the Customer Name / Mobile Number fields to blank (a Walk-in sale)', async () => {
    await openApp()
    editHashTo('#/sale/new')

    expect(await screen.findByLabelText(/customer name/i)).toHaveValue('')
    expect(screen.getByLabelText(/mobile number/i)).toHaveValue('')
  })

  it('shows suggestions when typing a customer name, and autofills the phone number on selection', async () => {
    const SUNITA: PartyListRow = { id: 9, name: 'Sunita Fabrics', phone: '9876500002', balance: 0, created_at: '2026-01-01 00:00:00' }
    await openApp([SUNITA])
    editHashTo('#/sale/new')

    await userEvent.type(await screen.findByLabelText(/customer name/i), 'Sunita')

    const suggestion = await screen.findByRole('button', { name: /Sunita Fabrics/i })
    await userEvent.click(suggestion)

    expect(screen.getByLabelText(/customer name/i)).toHaveValue('Sunita Fabrics')
    expect(screen.getByLabelText(/mobile number/i)).toHaveValue('9876500002')
  })

  it('quick-adds a new customer from the typed name + mobile number on save', async () => {
    await openApp()
    editHashTo('#/sale/new')

    const CREATED: SaleRecord = {
      id: 56,
      party_id: 12,
      salesman_user_id: COUNTER.id,
      salesman_id: 1,
      payment_mode: 'cash',
      cash_amount: 200,
      upi_amount: 0,
      credit_amount: 0,
      subtotal: 200,
      total_discount: 0,
      grand_total: 200,
      whatsapp_customer_sent: 0,
      whatsapp_owner_sent: 0,
      printed: 0,
      print_override_used: 0,
      is_cash_bill: 1,
      archived_local: 0,
      purge_at: '2026-11-20 00:00:00',
      created_at: '2026-08-22 00:00:00',
      items: [],
    }
    window.api.createSale = vi.fn().mockResolvedValue(CREATED)
    window.api.quickAddParty = vi.fn().mockResolvedValue({
      id: 12,
      name: 'New Walk-in',
      phone: '9998887777',
      address: null,
      balance: 0,
      created_at: '2026-08-22 00:00:00',
    })

    await addManualItem('Cotton Kurta')
    const { unitPrice } = cartQtyAndPriceInputs()
    await userEvent.clear(unitPrice)
    await userEvent.type(unitPrice, '200')

    await userEvent.type(screen.getByLabelText(/customer name/i), 'New Walk-in')
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9998887777')

    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }))

    await waitFor(() => expect(window.api.quickAddParty).toHaveBeenCalledWith({ name: 'New Walk-in', phone: '9998887777' }))
    expect(window.api.createSale).toHaveBeenCalledWith(expect.objectContaining({ partyId: 12 }))
  })

  it('blocks saving when only one of customer name / mobile number is filled in', async () => {
    await openApp()
    editHashTo('#/sale/new')

    await addManualItem('Cotton Kurta')
    const { unitPrice } = cartQtyAndPriceInputs()
    await userEvent.clear(unitPrice)
    await userEvent.type(unitPrice, '200')

    await userEvent.type(screen.getByLabelText(/customer name/i), 'Name Only')

    await userEvent.click(screen.getByRole('button', { name: /complete sale/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a mobile number/i)
    expect(window.api.createSale).not.toHaveBeenCalled()
  })

  it('keeps Print disabled before any sale has been completed', async () => {
    await openApp()
    editHashTo('#/sale/new')

    const printButton = await screen.findByRole('button', { name: /print bill/i })
    expect(printButton).toBeDisabled()
  })

  // Reversed on 2026-08-24: an undelivered bill no longer locks the printer,
  // because a resyncing WhatsApp session was stopping the counter outright.
  // What the counter gets instead is the plain statement that the copy is
  // queued. The "stop retrying" control is visible but sits behind the Owner
  // password (see the next case), so it is not an Owner-only *view*.
  it('allows Print while a WhatsApp copy is still queued, telling the counter so', async () => {
    await openApp()
    editHashTo('#/sale/new')

    await completeASale(makeSaleRecord({ whatsapp_customer_sent: 0, whatsapp_owner_sent: 1 }))

    expect(await screen.findByText(/the customer copy has not gone out yet/i)).toBeInTheDocument()
    expect(await screen.findByText(/queued and will send by itself/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /print bill/i })).toBeEnabled()
    // Offering the control does nothing on its own: it only asks for a password.
    expect(window.api.usePrintOverride).not.toHaveBeenCalled()
  })

  it('lets the Owner stop retrying a bill that will never send, behind their password, without that being needed to print', async () => {
    await openApp()
    editHashTo('#/sale/new')

    const pending = makeSaleRecord({ whatsapp_customer_sent: 0, whatsapp_owner_sent: 0 })
    await completeASale(pending)

    // The point of the reversal: printing is already available, so the control
    // below is about the retry queue, not about unlocking anything.
    expect(screen.getByRole('button', { name: /print bill/i })).toBeEnabled()

    window.api.usePrintOverride = vi.fn().mockResolvedValue({ ...pending, print_override_used: 1 })
    await userEvent.click(await screen.findByRole('button', { name: /stop retrying/i }))
    expect(window.api.usePrintOverride).not.toHaveBeenCalled()
    await unlock()

    await waitFor(() => expect(window.api.usePrintOverride).toHaveBeenCalledWith(pending.id))
    expect(await screen.findByRole('button', { name: /print bill/i })).toBeEnabled()
  })

  it('prints once both WhatsApp flags are true, calling printSale (the actual server-side gate) and setting Printed', async () => {
    // Printing itself happens in the main process via webContents.print() —
    // Electron has no print-preview UI, so a renderer-side window.print()
    // would only open a dead "doesn't support print preview" window. Nothing
    // here should be calling it.
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})

    await openApp()
    editHashTo('#/sale/new')

    const ready = makeSaleRecord({ whatsapp_customer_sent: 1, whatsapp_owner_sent: 1 })
    await completeASale(ready)

    const printButton = screen.getByRole('button', { name: /print bill/i })
    expect(printButton).toBeEnabled()

    window.api.printSale = vi.fn().mockResolvedValue({ ...ready, printed: 1 })
    await userEvent.click(printButton)

    expect(window.api.printSale).toHaveBeenCalledWith(ready.id)
    expect(printSpy).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: /printed/i })).toBeDisabled()
  })

  it('reports a cancelled print gently and leaves the bill unprinted and re-printable', async () => {
    await openApp()
    editHashTo('#/sale/new')

    const ready = makeSaleRecord({ whatsapp_customer_sent: 1, whatsapp_owner_sent: 1 })
    await completeASale(ready)

    window.api.printSale = vi.fn().mockRejectedValue(new Error('PRINT_CANCELLED'))
    await userEvent.click(screen.getByRole('button', { name: /print bill/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/print cancelled/i)
    expect(screen.getByRole('button', { name: /print bill/i })).toBeEnabled()
  })

  it('surfaces a clear error and leaves Print re-clickable if the server-side gate check rejects the print (e.g. a forged/direct call raced the real state)', async () => {
    await openApp()
    editHashTo('#/sale/new')

    const ready = makeSaleRecord({ whatsapp_customer_sent: 1, whatsapp_owner_sent: 1 })
    await completeASale(ready)

    window.api.printSale = vi.fn().mockRejectedValue(new Error('Print is blocked until both WhatsApp sends succeed or an Owner override is used.'))
    await userEvent.click(screen.getByRole('button', { name: /print bill/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/print is blocked/i)
    expect(screen.getByRole('button', { name: /print bill/i })).toBeEnabled()
  })
})

describe('Payment In screen (PHASE8.md section 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const RAMESH: PartyListRow = {
    id: 7,
    name: 'Ramesh',
    phone: '9876500001',
    balance: 1000,
    created_at: '2026-08-20 10:00:00',
  }

  async function selectRamesh() {
    await userEvent.type(await screen.findByPlaceholderText(/search by name or phone/i), 'Ram')
    await userEvent.click(await screen.findByRole('button', { name: /Ramesh/ }))
  }

  it('is reachable by a Salesman and records a payment, showing the updated balance without a refetch', async () => {
    await openApp([RAMESH])
    editHashTo('#/payment-in')

    await selectRamesh()
    await userEvent.type(screen.getByLabelText(/^amount$/i), '400')
    await userEvent.type(screen.getByLabelText(/note/i), 'part payment')

    window.api.recordPayment = vi.fn().mockResolvedValue({
      payment: {
        id: 1,
        party_id: RAMESH.id,
        amount: 400,
        mode: 'cash',
        note: 'part payment',
        recorded_by_user_id: COUNTER.id,
        created_at: '2026-08-24 10:00:00',
      },
      party: { ...RAMESH, address: null, balance: 600 },
    })

    await userEvent.click(screen.getByRole('button', { name: /record payment/i }))

    await waitFor(() =>
      expect(window.api.recordPayment).toHaveBeenCalledWith({
        partyId: RAMESH.id,
        amount: 400,
        mode: 'cash',
        note: 'part payment',
      }),
    )
    // The balance shown comes straight out of the same response (section 2,
    // step 4) — asserted on the confirmation line specifically, since the
    // party panel above it correctly re-renders with the new balance too.
    const confirmation = await screen.findByText(/Updated balance/i)
    expect(confirmation).toHaveTextContent('₹600.00')
  })

  it('is reachable by an Owner too (PHASE8.md acceptance criterion 3)', async () => {
    await openApp([RAMESH])
    editHashTo('#/payment-in')

    expect(await screen.findByRole('heading', { name: /payment in/i })).toBeInTheDocument()
    expect(screen.queryByText(/access denied/i)).not.toBeInTheDocument()
  })

  it('sends the chosen UPI mode rather than the Cash default', async () => {
    await openApp([RAMESH])
    editHashTo('#/payment-in')

    await selectRamesh()
    await userEvent.type(screen.getByLabelText(/^amount$/i), '250')
    await userEvent.click(screen.getByRole('button', { name: 'UPI' }))

    window.api.recordPayment = vi.fn().mockResolvedValue({
      payment: {
        id: 2,
        party_id: RAMESH.id,
        amount: 250,
        mode: 'upi',
        note: null,
        recorded_by_user_id: OWNER.id,
        created_at: '2026-08-24 10:00:00',
      },
      party: { ...RAMESH, address: null, balance: 750 },
    })

    await userEvent.click(screen.getByRole('button', { name: /record payment/i }))

    await waitFor(() =>
      expect(window.api.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'upi', note: null }),
      ),
    )
  })

  /** PHASE8.md acceptance criterion 5 — blocked inline, before the IPC call is ever made. */
  it('blocks an amount of 0 or less with an inline error and never calls the backend', async () => {
    await openApp([RAMESH])
    editHashTo('#/payment-in')

    await selectRamesh()
    await userEvent.type(screen.getByLabelText(/^amount$/i), '0')

    expect(await screen.findByText(/amount must be greater than 0/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /record payment/i })).toBeDisabled()
    expect(window.api.recordPayment).not.toHaveBeenCalled()
  })

  it('blocks recording with no party selected and never calls the backend', async () => {
    await openApp([RAMESH])
    editHashTo('#/payment-in')

    await userEvent.type(await screen.findByLabelText(/^amount$/i), '400')

    expect(await screen.findByText(/select the party this payment is from/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /record payment/i })).toBeDisabled()
    expect(window.api.recordPayment).not.toHaveBeenCalled()
  })

  it('surfaces a backend rejection instead of showing a false confirmation', async () => {
    await openApp([RAMESH])
    editHashTo('#/payment-in')

    await selectRamesh()
    await userEvent.type(screen.getByLabelText(/^amount$/i), '400')

    window.api.recordPayment = vi.fn().mockRejectedValue(new Error('Party 7 not found'))
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }))

    expect(await screen.findByText(/party 7 not found/i)).toBeInTheDocument()
    expect(screen.queryByText(/updated balance/i)).not.toBeInTheDocument()
  })

  /**
   * PHASE8.md acceptance criterion 2 / section 5: this flow has no WhatsApp
   * send and no print step. Pinned as a test so a later phase can't quietly
   * add either to this screen.
   */
  it('offers no print or WhatsApp action anywhere, before or after recording', async () => {
    await openApp([RAMESH])
    editHashTo('#/payment-in')

    await selectRamesh()
    await userEvent.type(screen.getByLabelText(/^amount$/i), '400')

    window.api.recordPayment = vi.fn().mockResolvedValue({
      payment: {
        id: 3,
        party_id: RAMESH.id,
        amount: 400,
        mode: 'cash',
        note: null,
        recorded_by_user_id: OWNER.id,
        created_at: '2026-08-24 10:00:00',
      },
      party: { ...RAMESH, address: null, balance: 600 },
    })
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }))
    await screen.findByText(/updated balance/i)

    expect(screen.queryByRole('button', { name: /print/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /whatsapp/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
    expect(window.api.printSale).not.toHaveBeenCalled()
    expect(window.api.printPage).not.toHaveBeenCalled()
  })

  it('pre-selects the party when opened from a Party Ledger via ?partyId=', async () => {
    await openApp([RAMESH])
    editHashTo('#/payment-in?partyId=7')

    expect(await screen.findByDisplayValue('Ramesh')).toBeInTheDocument()
    expect(screen.getByText(/outstanding balance for Ramesh/i)).toBeInTheDocument()
  })
})

describe('Expenses screen (PHASE9.md section 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const RENT: ExpenseRecord = {
    id: 1,
    category: 'Rent',
    amount: 12000,
    expense_date: '2026-08-01',
    note: 'August shop rent',
    logged_by_user_id: OWNER.id,
    created_at: '2026-08-01 09:00:00',
  }

  const TRANSPORT: ExpenseRecord = {
    id: 2,
    category: 'Transport',
    amount: 150,
    expense_date: '2026-08-10',
    note: null,
    logged_by_user_id: COUNTER.id,
    created_at: '2026-08-10 18:00:00',
  }

  /** Both fixtures carry the joined name the list query supplies. */
  const EXPENSES: ExpenseListRow[] = [
    { ...TRANSPORT, logged_by_name: 'Test Salesman' },
    { ...RENT, logged_by_name: 'Shop Owner' },
  ]

  async function openExpenses(rows: ExpenseListRow[] = EXPENSES) {
    await openApp()
    window.api.getExpenses = vi.fn().mockResolvedValue(rows)
    editHashTo('#/expenses')
    await screen.findByRole('heading', { name: /^expenses$/i })
    // The heading renders before `getExpenses` resolves, so wait for the list
    // itself to settle — otherwise a synchronous getByText races the rows in.
    // Counted by row rather than matched by text: a category name also appears
    // in the form's own category dropdown, so text alone is ambiguous.
    await waitFor(() =>
      expect(screen.getAllByRole('row')).toHaveLength((rows.length || 1) + 1),
    )
  }

  /**
   * PHASE9.md acceptance criterion 1 — the confirmed decision that a Salesman
   * logs expenses, not just the Owner. Nav item, form and the full shop-wide
   * list, all in one pass.
   */
  it('gives a Salesman an Expenses nav item, the add form, and the whole shop list', async () => {
    await openExpenses()

    expect(screen.getByRole('link', { name: /expenses/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add expense/i })).toBeInTheDocument()

    // Not narrowed to this Salesman's own entries — the Owner-logged rent is
    // here too. Scoped to the table: the TopBar also greets "Test Salesman".
    const list = within(screen.getByRole('table'))
    expect(list.getByText('August shop rent')).toBeInTheDocument()
    expect(list.getByText('Shop Owner')).toBeInTheDocument()
    expect(list.getByText('Test Salesman')).toBeInTheDocument()
  })

  it('lets a Salesman log an expense, defaulting the date to today', async () => {
    await openExpenses()

    const today = todayIsoDate()
    expect(screen.getByLabelText(/^date$/i)).toHaveValue(today)

    await userEvent.selectOptions(screen.getByLabelText(/category/i), 'Electricity')
    await userEvent.type(screen.getByLabelText(/^amount$/i), '2400')
    await userEvent.type(screen.getByLabelText(/note/i), 'August bill')

    window.api.logExpense = vi.fn().mockResolvedValue({
      id: 3,
      category: 'Electricity',
      amount: 2400,
      expense_date: today,
      note: 'August bill',
      logged_by_user_id: COUNTER.id,
      created_at: '2026-08-24 09:00:00',
    })

    await userEvent.click(screen.getByRole('button', { name: /add expense/i }))

    await waitFor(() =>
      expect(window.api.logExpense).toHaveBeenCalledWith({
        category: 'Electricity',
        amount: 2400,
        date: today,
        note: 'August bill',
      }),
    )
    expect(await screen.findByText(/logged ₹2,400\.00 — Electricity/i)).toBeInTheDocument()
  })

  it('logs a back-dated expense with the date the operator chose', async () => {
    await openExpenses()

    fireEvent.change(screen.getByLabelText(/^date$/i), { target: { value: '2026-08-01' } })
    await userEvent.type(screen.getByLabelText(/^amount$/i), '12000')

    window.api.logExpense = vi.fn().mockResolvedValue({ ...RENT, note: null })
    await userEvent.click(screen.getByRole('button', { name: /add expense/i }))

    await waitFor(() =>
      expect(window.api.logExpense).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2026-08-01', note: null }),
      ),
    )
  })

  it('is reachable by an Owner too', async () => {
    await openExpenses()

    expect(screen.queryByText(/access denied/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add expense/i })).toBeInTheDocument()
  })

  /** Same two-layer discipline as Payment-In: blocked inline, before any IPC call. */
  it('blocks an amount of 0 or less with an inline error and never calls the backend', async () => {
    await openExpenses()

    await userEvent.type(screen.getByLabelText(/^amount$/i), '0')

    expect(await screen.findByText(/amount must be greater than 0/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add expense/i })).toBeDisabled()
    expect(window.api.logExpense).not.toHaveBeenCalled()
  })

  it('surfaces a backend rejection instead of showing a false confirmation', async () => {
    await openExpenses()

    await userEvent.type(screen.getByLabelText(/^amount$/i), '500')
    window.api.logExpense = vi.fn().mockRejectedValue(new Error('Expense amount must be greater than 0.'))

    await userEvent.click(screen.getByRole('button', { name: /add expense/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/greater than 0/i)
    expect(screen.queryByText(/^Logged ₹/)).not.toBeInTheDocument()
  })

  /** PHASE9.md acceptance criterion 4. */
  it('passes the chosen date range to the list query and reloads', async () => {
    await openExpenses()

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '2026-08-05' } })
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: '2026-08-20' } })

    await waitFor(() =>
      expect(window.api.getExpenses).toHaveBeenCalledWith({ from: '2026-08-05', to: '2026-08-20' }),
    )
  })

  it('clears the date range back to the full list', async () => {
    await openExpenses()

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '2026-08-05' } })
    await screen.findByRole('button', { name: /clear dates/i })

    await userEvent.click(screen.getByRole('button', { name: /clear dates/i }))

    await waitFor(() =>
      expect(window.api.getExpenses).toHaveBeenLastCalledWith({ from: null, to: null }),
    )
  })

  it('says the range is empty rather than that nothing has ever been logged', async () => {
    await openExpenses([])

    expect(await screen.findByText(/no expenses logged yet/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '2026-01-01' } })

    expect(await screen.findByText(/no expenses in this date range/i)).toBeInTheDocument()
  })

  /**
   * PHASE9.md acceptance criterion 2 / section 1 — no edit or delete control
   * anywhere on this screen. It used to be asserted per role; there is one
   * session now, and this screen is open at the counter, which makes the
   * absence matter more rather than less. The Owner holds `expense:edit` but
   * no UI is built for it, so a later phase adding a row action here should
   * have to come through the client first, and past this test.
   */
  it('offers no edit or delete control', async () => {
    await openExpenses()

    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /actions/i })).not.toBeInTheDocument()
  })
})

/**
 * PHASE10.md section 1 — the Owner's whole-shop view of today.
 *
 * Every figure comes from the one `getOwnerDashboard()` call, so these cases
 * are really asserting that each field of that payload reaches the right place
 * on screen. The fixture's numbers are all distinct for that reason: two cards
 * showing the same amount would pass a test that had them swapped.
 */
describe('Owner dashboard (PHASE10.md section 1)', () => {
  async function openOwnerDashboard() {
    await openApp()
    editHashTo('#/dashboard')
    return screen.findByRole('heading', { name: /today at a glance/i })
  }

  it("shows today's sales total, the cash/UPI split, credit, outstanding credit and expenses", async () => {
    await openOwnerDashboard()

    expect(await screen.findByText('₹4,400.00')).toBeInTheDocument()
    expect(screen.getByText('₹1,800.00')).toBeInTheDocument()
    expect(screen.getByText('₹2,250.00')).toBeInTheDocument()
    expect(screen.getByText('₹1,000.00')).toBeInTheDocument()
    expect(screen.getByText('₹12,750.00')).toBeInTheDocument()
    expect(screen.getByText('₹830.00')).toBeInTheDocument()
  })

  /**
   * Acceptance criterion 4, made visible: the Cash figure is this day's sale
   * cash *plus* this day's Payment-In cash, and both halves are shown so a
   * wrong total can be traced to which half is wrong. A credit sale's
   * credit_amount is in neither half — it sits under "Credit Given Today".
   */
  it('breaks each collected figure into its sale half and its Payment-In half', async () => {
    await openOwnerDashboard()

    expect(
      await screen.findByText('₹1,550.00 from sales + ₹250.00 from Payment-In'),
    ).toBeInTheDocument()
    expect(screen.getByText('₹1,850.00 from sales + ₹400.00 from Payment-In')).toBeInTheDocument()
  })

  it('attributes each row of the breakdown to the salesman who made the sales', async () => {
    await openOwnerDashboard()

    const anil = (await screen.findByText('Anil Salesman')).closest('tr')!
    expect(within(anil).getByText('₹3,250.00')).toBeInTheDocument()
    expect(within(anil).getByText('₹1,200.00')).toBeInTheDocument()
    expect(within(anil).getByText('₹1,100.00')).toBeInTheDocument()
    expect(within(anil).getByText('₹950.00')).toBeInTheDocument()

    const bhavna = screen.getByText('Bhavna Salesman').closest('tr')!
    expect(within(bhavna).getByText('₹1,150.00')).toBeInTheDocument()
    expect(within(bhavna).getByText('₹350.00')).toBeInTheDocument()
    expect(within(bhavna).getByText('₹750.00')).toBeInTheDocument()
    expect(within(bhavna).getByText('₹50.00')).toBeInTheDocument()
  })

  it('offers the section 1 quick links, with Reports now a live link', async () => {
    await openOwnerDashboard()

    // Scoped to the Quick Links section: the sidebar carries links with the
    // same labels, and an unscoped query would pass on those instead.
    const quickLinks = within(
      (await screen.findByRole('heading', { name: /quick links/i })).closest('section')!,
    )

    expect(quickLinks.getByRole('link', { name: /new sale/i })).toHaveAttribute('href', '#/sale/new')
    expect(quickLinks.getByRole('link', { name: /payment in/i })).toHaveAttribute('href', '#/payment-in')
    expect(quickLinks.getByRole('link', { name: /^parties$/i })).toHaveAttribute('href', '#/parties')
    expect(quickLinks.getByRole('link', { name: /^expenses$/i })).toHaveAttribute('href', '#/expenses')

    // Rewritten in Phase 11 rather than deleted, so the reversal is pinned as
    // explicitly as the old rule was: through Phase 10 this tile was a plain
    // aria-disabled div, because an enabled link to the then-unbuilt /reports
    // would have bounced off App.tsx's catch-all and read as a bug. /reports
    // exists now, so it is a real link and must stay one.
    expect(quickLinks.getByRole('link', { name: /^reports$/i })).toHaveAttribute('href', '#/reports')
    expect(quickLinks.queryByText('Reports')).not.toHaveAttribute('aria-disabled')
  })

  it('refetches on Refresh, so the numbers can be brought up to date during the day', async () => {
    await openOwnerDashboard()
    await screen.findByText('₹4,400.00')
    expect(window.api.getOwnerDashboard).toHaveBeenCalledTimes(1)

    vi.mocked(window.api.getOwnerDashboard).mockResolvedValue({
      ...OWNER_DASHBOARD,
      summary: { ...OWNER_DASHBOARD.summary, salesTotal: 7777 },
    })
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }))

    expect(await screen.findByText('₹7,777.00')).toBeInTheDocument()
    expect(window.api.getOwnerDashboard).toHaveBeenCalledTimes(2)
  })
})

/*
 * The `Salesman dashboard` suite stood here until 2026-08-27. It proved a
 * salesman session saw only its own day and never called the Owner channel.
 * Both the screen and the session are gone with the salesman login: there is
 * one dashboard, it is shop-wide, and what keeps the counter out of it is the
 * Owner password gate (see `the Owner password gate` above) backed by
 * `report:view_all` in `reports.test.ts`.
 */

describe('Reports screen', () => {
  async function openReports() {
    await openApp()
    editHashTo('#/dashboard')
    await screen.findByRole('heading', { name: /today at a glance/i })
    editHashTo('#/reports')
    return screen.findByRole('heading', { name: /^reports$/i })
  }

  it('is reachable from the Owner dashboard quick links, which are no longer inert', async () => {
    await openApp()
    editHashTo('#/dashboard')

    const quickLinks = within(
      (await screen.findByRole('heading', { name: /quick links/i })).closest('section')!,
    )
    // Phase 10 rendered this as a disabled div because /reports did not exist.
    expect(quickLinks.getByRole('link', { name: /reports/i })).toHaveAttribute('href', '#/reports')
  })

  /**
   * The entry is in the sidebar for everyone since 2026-08-27 — there is no role
   * to hide it from, and hiding it was never the control anyway. What the entry
   * carries now is the lock, so that a salesman sees the password coming before
   * they click rather than being surprised by it.
   */
  it('shows a Reports nav entry, with no padlock now that the screen is open', async () => {
    await openApp()

    // Scoped to the sidebar — the dashboard's quick-link tile carries the same
    // label, and an unscoped query would pass on that instead.
    const nav = within(screen.getByRole('navigation'))
    const link = nav.getByRole('link', { name: /reports/i })
    expect(link).toHaveAttribute('href', '#/reports')
    expect(within(link).queryByLabelText('Locked')).not.toBeInTheDocument()
  })

  it('opens on the Daily Sales tab and asks for this month by default', async () => {
    await openReports()

    await waitFor(() => expect(window.api.getDailySalesReport).toHaveBeenCalled())

    const today = todayIsoDate()
    const range = vi.mocked(window.api.getDailySalesReport).mock.calls[0][0]
    // "Default: this month, but freely adjustable" (section 1) — month-to-date,
    // so `to` is today rather than the end of the month.
    expect(range.from).toBe(`${today.slice(0, 7)}-01`)
    expect(range.to).toBe(today)
  })

  it('renders the daily sales figures, including both halves of each split', async () => {
    await openReports()

    // The two-part detail is what makes the cash/UPI split checkable by eye
    // rather than only by test — same reasoning as the Owner dashboard's cards.
    expect(await screen.findByText('₹7,800.00')).toBeInTheDocument()
    expect(screen.getByText(/₹6,550\.00 from sales \+ ₹1,250\.00 from Payment-In/)).toBeInTheDocument()
    expect(screen.getByText('₹8,750.00')).toBeInTheDocument()
    expect(screen.getByText(/₹7,850\.00 from sales \+ ₹900\.00 from Payment-In/)).toBeInTheDocument()
    expect(screen.getByText('₹18,400.00')).toBeInTheDocument()
    expect(screen.getByText('₹4,000.00')).toBeInTheDocument()
    expect(screen.getByText('₹2,150.00')).toBeInTheDocument()
  })

  it('refetches when the date range changes', async () => {
    await openReports()
    await waitFor(() => expect(window.api.getDailySalesReport).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '2026-07-01' } })
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: '2026-07-31' } })

    await waitFor(() =>
      expect(window.api.getDailySalesReport).toHaveBeenLastCalledWith({
        from: '2026-07-01',
        to: '2026-07-31',
      }),
    )
  })

  it('narrows to today in one click, which is how criterion 1 gets checked', async () => {
    await openReports()
    await waitFor(() => expect(window.api.getDailySalesReport).toHaveBeenCalled())

    await userEvent.click(screen.getByRole('button', { name: /^today$/i }))

    const today = todayIsoDate()
    await waitFor(() =>
      expect(window.api.getDailySalesReport).toHaveBeenLastCalledWith({ from: today, to: today }),
    )
  })

  it('refuses to query a backwards range and says so inline', async () => {
    await openReports()
    await waitFor(() => expect(window.api.getDailySalesReport).toHaveBeenCalled())
    const callsBefore = vi.mocked(window.api.getDailySalesReport).mock.calls.length

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '2026-09-30' } })

    expect(await screen.findByText(/start date is after the end date/i)).toBeInTheDocument()
    // The main process would reject this anyway; not sending it means the
    // operator is told by the field they just edited instead of by a failure.
    expect(vi.mocked(window.api.getDailySalesReport).mock.calls).toHaveLength(callsBefore)
  })

  it('exports the daily sales CSV with the figures that are on screen', async () => {
    await openReports()
    await screen.findByText('₹18,400.00')

    await userEvent.click(screen.getByRole('button', { name: /export csv/i }))

    await waitFor(() => expect(window.api.exportCsv).toHaveBeenCalled())
    const [fileName, csv] = vi.mocked(window.api.exportCsv).mock.calls[0]

    expect(fileName).toBe('daily-sales-2026-08-01-to-2026-08-24.csv')
    // Raw numbers, not the ₹-formatted strings on the cards: same values,
    // unformatted so the accountant can sum the column (criterion 4).
    expect(csv).toContain('Total Sales,18400')
    expect(csv).toContain('Cash Collected,7800')
    expect(csv).toContain('Cash from Payment-In,1250')
    expect(csv).toContain('UPI Collected,8750')
    expect(csv).toContain('Credit Issued,4000')
    expect(csv).toContain('Credit Collected,2150')
    expect(csv).toContain('Total Collected,16550')
  })

  it('reports where the file was saved', async () => {
    await openReports()
    await screen.findByText('₹18,400.00')

    await userEvent.click(screen.getByRole('button', { name: /export csv/i }))

    expect(await screen.findByText(/Saved to C:\\Users\\owner\\report\.csv/)).toBeInTheDocument()
  })

  it('says nothing when the save dialog is dismissed, since that is not a failure', async () => {
    await openReports()
    await screen.findByText('₹18,400.00')
    vi.mocked(window.api.exportCsv).mockResolvedValue({ saved: false, filePath: null })

    await userEvent.click(screen.getByRole('button', { name: /export csv/i }))

    await waitFor(() => expect(window.api.exportCsv).toHaveBeenCalled())
    expect(screen.queryByText(/could not save/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/saved to/i)).not.toBeInTheDocument()
  })

  it('does not fetch a tab that has not been opened', async () => {
    await openReports()
    await waitFor(() => expect(window.api.getDailySalesReport).toHaveBeenCalled())

    // The tab container switches and nothing else — an unopened report has
    // issued no query and holds no rows, which is why it must not fetch.
    expect(window.api.getSalesmanReport).not.toHaveBeenCalled()
    expect(window.api.getPartyOutstandingReport).not.toHaveBeenCalled()
  })

  it('shows the salesman-wise breakdown on its tab', async () => {
    await openReports()

    await userEvent.click(screen.getByRole('tab', { name: /salesman-wise/i }))

    // By role, not by exact text: the name sits in a button beside a disclosure
    // marker, so its text node is split.
    expect(await screen.findByRole('button', { name: /anil salesman/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /bhavna salesman/i })).toBeInTheDocument()
    expect(screen.getByText('₹13,250.00')).toBeInTheDocument()
    expect(screen.getByText('₹5,150.00')).toBeInTheDocument()
  })

  it('drills into a salesman on click, fetching only then', async () => {
    await openReports()
    await userEvent.click(screen.getByRole('tab', { name: /salesman-wise/i }))
    await screen.findByRole('button', { name: /anil salesman/i })

    // Not pre-loaded with the breakdown: a month of totals is six rows, and
    // every bill behind them is not what opening the tab should cost.
    expect(window.api.getSalesmanSales).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /anil salesman/i }))

    // Derived, not hardcoded: this is the *picker's* live default
    // (`thisMonthRange`, month-to-date), unlike the export-filename assertions
    // below, which read the range the mocked report echoes back. A literal here
    // passes only on the one day it was written.
    await waitFor(() => expect(window.api.getSalesmanSales).toHaveBeenCalledWith(2, thisMonthRange()))
    expect(await screen.findByText('Ramesh Textiles')).toBeInTheDocument()
    // A walk-in cash sale has no party — matches NewSaleScreen's wording.
    expect(screen.getByText('Walk-in Customer')).toBeInTheDocument()
    expect(screen.getByText('₹900.00')).toBeInTheDocument()
  })

  it('closes the drill-down on a second click', async () => {
    await openReports()
    await userEvent.click(screen.getByRole('tab', { name: /salesman-wise/i }))
    await screen.findByRole('button', { name: /anil salesman/i })

    await userEvent.click(screen.getByRole('button', { name: /anil salesman/i }))
    expect(await screen.findByText('Ramesh Textiles')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /anil salesman/i }))
    await waitFor(() => expect(screen.queryByText('Ramesh Textiles')).not.toBeInTheDocument())
  })

  it('exports the breakdown and the open drill-down as separate files', async () => {
    await openReports()
    await userEvent.click(screen.getByRole('tab', { name: /salesman-wise/i }))
    await screen.findByRole('button', { name: /anil salesman/i })
    await userEvent.click(screen.getByRole('button', { name: /anil salesman/i }))
    await screen.findByText('Ramesh Textiles')

    // Two buttons, not one whose contents change with hidden state — a file
    // nobody can predict from the screen is the thing being avoided.
    const exportButtons = screen.getAllByRole('button', { name: /export csv/i })
    expect(exportButtons).toHaveLength(2)

    await userEvent.click(exportButtons[0])
    await waitFor(() => expect(window.api.exportCsv).toHaveBeenCalled())
    const [breakdownName, breakdownCsv] = vi.mocked(window.api.exportCsv).mock.calls[0]
    expect(breakdownName).toBe('salesman-sales-2026-08-01-to-2026-08-24.csv')
    expect(breakdownCsv).toContain('Anil Salesman,6,13250,5200,4100,3950')
    expect(breakdownCsv).toContain('Bhavna Salesman,3,5150,1350,3750,50')

    await userEvent.click(exportButtons[1])
    await waitFor(() => expect(vi.mocked(window.api.exportCsv).mock.calls).toHaveLength(2))
    const [drillName, drillCsv] = vi.mocked(window.api.exportCsv).mock.calls[1]
    expect(drillName).toContain('anil-salesman')
    expect(drillCsv).toContain('Ramesh Textiles')
    expect(drillCsv).toContain('Walk-in Customer')
  })

  it('lists party balances, marks an advance, and totals positives only', async () => {
    await openReports()

    await userEvent.click(screen.getByRole('tab', { name: /party outstanding/i }))

    expect(await screen.findByText('Ramesh Textiles')).toBeInTheDocument()
    expect(screen.getByText('₹12,400.00')).toBeInTheDocument()
    expect(screen.getByText('₹850.00')).toBeInTheDocument()
    // The overpaid party is shown as an advance, not as a negative debt.
    expect(screen.getByText(/₹1,200\.00 advance/)).toBeInTheDocument()
    // 12400 + 850 — the -1200 is deliberately not netted off (criterion 3).
    expect(screen.getByText('₹13,250.00')).toBeInTheDocument()
    expect(screen.getByText(/2 parties owe.*1 in advance, not counted/)).toBeInTheDocument()
  })

  it('exports the outstanding list with a negative balance left summable', async () => {
    await openReports()
    await userEvent.click(screen.getByRole('tab', { name: /party outstanding/i }))
    await screen.findByText('Ramesh Textiles')

    await userEvent.click(screen.getByRole('button', { name: /export csv/i }))

    await waitFor(() => expect(window.api.exportCsv).toHaveBeenCalled())
    const [, csv] = vi.mocked(window.api.exportCsv).mock.calls[0]

    expect(csv).toContain('Ramesh Textiles,9876500001,12400')
    // No phone on file leaves a blank cell, not the word "null".
    expect(csv).toContain('Meena Fabrics,,850')
    // `-1200`, not `'-1200` — the formula guard skips numeric cells precisely
    // so this column stays summable in Excel.
    expect(csv).toContain('Kiran Stores,9876500003,-1200')
    expect(csv).toContain('Total Outstanding (amounts owed only),,13250')
  })

  it('surfaces a query failure rather than rendering an empty report', async () => {
    await openApp()
    editHashTo('#/dashboard')
    await screen.findByRole('heading', { name: /today at a glance/i })
    vi.mocked(window.api.getDailySalesReport).mockRejectedValue(new Error('nope'))

    editHashTo('#/reports')

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load the sales report/i)
  })
})

/**
 * Settings screen (PHASE12.md section 1) — Owner-only, and the screen that
 * retires the temporary hardcoded shop header and Owner WhatsApp number.
 *
 * The route guard itself is covered in the `RequireRole guard` block above,
 * including the assertion that a Salesman session issues no settings or user
 * query at all. These cases are about what the Owner can actually do here.
 */
describe('Settings screen', () => {
  async function openSettings() {
    await openApp()
    editHashTo('#/dashboard')
    await screen.findByRole('heading', { name: /today at a glance/i })
    editHashTo('#/settings')
    return screen.findByRole('heading', { name: /^settings$/i })
  }

  /**
   * A row picked by its **username cell**, not by any cell that happens to
   * contain the text — the Role column renders 'owner'/'salesman' too, so a
   * bare cell query matches two cells in the Owner's row.
   */
  /** The Salesmen panel is a list, not a table — one <li> per person. */
  function salesmanRow(name: string): HTMLElement {
    const row = screen
      .getAllByRole('listitem')
      .find((candidate) => candidate.textContent?.includes(name))
    if (!row) throw new Error(`No salesman row for "${name}"`)
    return row
  }

  it('shows a Settings nav entry, with no padlock now that the screen is open', async () => {
    await openApp()

    const nav = within(screen.getByRole('navigation'))
    const link = nav.getByRole('link', { name: /settings/i })
    expect(link).toHaveAttribute('href', '#/settings')
    expect(within(link).queryByLabelText('Locked')).not.toBeInTheDocument()
  })

  it('loads the saved shop details into the form rather than any hardcoded value', async () => {
    await openSettings()

    expect(await screen.findByDisplayValue(SHOP_SETTINGS.shopName)).toBeInTheDocument()
    expect(screen.getByDisplayValue(SHOP_SETTINGS.shopAddress)).toBeInTheDocument()
    expect(screen.getByDisplayValue(SHOP_SETTINGS.shopPhone)).toBeInTheDocument()
    expect(screen.getByDisplayValue(SHOP_SETTINGS.ownerWhatsappNumber)).toBeInTheDocument()
  })

  it('saves an edited shop name and Owner number through one call', async () => {
    await openSettings()

    const nameField = await screen.findByDisplayValue(SHOP_SETTINGS.shopName)
    await userEvent.clear(nameField)
    await userEvent.type(nameField, 'Renamed Collections')

    const whatsappField = screen.getByLabelText(/whatsapp number/i)
    await userEvent.clear(whatsappField)
    await userEvent.type(whatsappField, '9876511111')

    await userEvent.click(screen.getByRole('button', { name: /save shop details/i }))
await unlock()

    await waitFor(() =>
      expect(window.api.setShopSettings).toHaveBeenCalledWith({
        shopName: 'Renamed Collections',
        shopAddress: SHOP_SETTINGS.shopAddress,
        shopPhone: SHOP_SETTINGS.shopPhone,
        ownerWhatsappNumber: '9876511111',
      }),
    )
    expect(await screen.findByText(/^Saved\./i)).toBeInTheDocument()
  })

  /**
   * A blank Owner number would park every future bill in the "not sent" queue
   * forever (`getSalesAwaitingWhatsApp` counts `whatsapp_owner_sent = 0`
   * unconditionally), so the screen must not even send the call.
   */
  it('refuses to submit a blank Owner WhatsApp number', async () => {
    await openSettings()

    const whatsappField = await screen.findByLabelText(/whatsapp number/i)
    await userEvent.clear(whatsappField)

    expect(await screen.findByText(/queued as undelivered/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save shop details/i })).toBeDisabled()
    expect(window.api.setShopSettings).not.toHaveBeenCalled()
  })

  it('shows the Owner number in the form it will actually be dialled in', async () => {
    await openSettings()

    const whatsappField = await screen.findByLabelText(/whatsapp number/i)
    await userEvent.clear(whatsappField)
    await userEvent.type(whatsappField, '9876511111')

    // toWhatsAppNumber prepends the country code to a bare 10-digit number.
    expect(screen.getByText(/\+919876511111/)).toBeInTheDocument()
  })

  /*
   * The `Staff Logins` cases stood here until 2026-08-27 — creating a salesman
   * login, disabling one, resetting its password. None of those things exist
   * any more: a salesman is a name, not an account. What replaces them is this
   * panel, plus the Owner password change that the gate now depends on.
   */

  it('lists every salesman, showing which have been retired', async () => {
    await openSettings()

    expect(await screen.findByText('Anil Salesman')).toBeInTheDocument()
    expect(screen.getByText('Bhavna Salesman')).toBeInTheDocument()
    expect(within(salesmanRow('Old Staff')).getByText(/retired/i)).toBeInTheDocument()
  })

  it('adds a salesman and puts them in the list', async () => {
    await openSettings()
    vi.mocked(window.api.createSalesman).mockResolvedValue({
      id: 4,
      name: 'Chetan Kumar',
      is_active: 1,
      legacy_user_id: null,
      created_at: '2026-08-27 10:00:00',
    })

    await userEvent.type(await screen.findByLabelText(/add a salesman/i), 'Chetan Kumar')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
await unlock()

    await waitFor(() => expect(window.api.createSalesman).toHaveBeenCalledWith('Chetan Kumar'))
    expect(await screen.findByText('Chetan Kumar')).toBeInTheDocument()
  })

  /** No username, no password, no confirm — that absence is the whole point of the change. */
  it('asks for nothing but a name', async () => {
    await openSettings()
    await screen.findByLabelText(/add a salesman/i)

    const panel = within(screen.getByRole('heading', { name: /^salesmen$/i }).closest('section')!)
    expect(panel.queryByLabelText(/username/i)).not.toBeInTheDocument()
    expect(panel.queryByLabelText(/password/i)).not.toBeInTheDocument()
  })

  it('surfaces a duplicate-name rejection instead of appearing to succeed', async () => {
    await openSettings()
    vi.mocked(window.api.createSalesman).mockRejectedValue(
      new Error('There is already a salesman called "Anil Salesman".'),
    )

    await userEvent.type(await screen.findByLabelText(/add a salesman/i), 'Anil Salesman')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
await unlock()

    expect(await screen.findByText(/already a salesman called/i)).toBeInTheDocument()
  })

  it('renames a salesman', async () => {
    await openSettings()
    vi.mocked(window.api.renameSalesman).mockResolvedValue({ ...SALESMEN[0], name: 'Anil Kumar' })

    await screen.findByText('Anil Salesman')
    await userEvent.click(within(salesmanRow('Anil Salesman')).getByRole('button', { name: /rename/i }))
    const field = screen.getByLabelText(/new name for anil salesman/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'Anil Kumar')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
await unlock()

    await waitFor(() => expect(window.api.renameSalesman).toHaveBeenCalledWith(1, 'Anil Kumar'))
    // Says so out loud, because renaming is retroactive across every past bill.
    expect(await screen.findByText(/past bills now show the corrected name/i)).toBeInTheDocument()
  })

  it('retires a salesman, saying their past sales keep their name', async () => {
    await openSettings()
    vi.mocked(window.api.setSalesmanActive).mockResolvedValue({ ...SALESMEN[0], is_active: 0 })

    await screen.findByText('Anil Salesman')
    await userEvent.click(within(salesmanRow('Anil Salesman')).getByRole('button', { name: /^retire$/i }))
await unlock()

    await waitFor(() => expect(window.api.setSalesmanActive).toHaveBeenCalledWith(1, false))
    expect(await screen.findByText(/past sales still show their name/i)).toBeInTheDocument()
  })

  it('brings a retired salesman back', async () => {
    await openSettings()
    vi.mocked(window.api.setSalesmanActive).mockResolvedValue({ ...SALESMEN[2], is_active: 1 })

    await screen.findByText('Old Staff')
    await userEvent.click(within(salesmanRow('Old Staff')).getByRole('button', { name: /bring back/i }))
await unlock()

    await waitFor(() => expect(window.api.setSalesmanActive).toHaveBeenCalledWith(3, true))
  })

  /**
   * A deliberate absence, pinned so a later phase cannot quietly add one — the
   * rule Phase 12 stated for logins, carried over: every bill references
   * `salesmen.id`, so a delete would strip the attribution off all of it.
   */
  it('offers no way to delete a salesman', async () => {
    await openSettings()
    await screen.findByText('Anil Salesman')

    // Scoped to the Salesmen panel: the Retention panel legitimately talks
    // about removing *bills*, and a page-wide text match would collide with it
    // while saying nothing about this one.
    const panel = within(screen.getByRole('heading', { name: /^salesmen$/i }).closest('section')!)
    expect(panel.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(panel.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
  })

  /*
   * The Owner password change. New with the gate rather than beside it: that
   * password now stands in front of everything and gets typed at a counter in
   * earshot of staff, so rotating it is part of the lock.
   */

  it('changes the Owner password, current password required', async () => {
    await openSettings()

    await userEvent.type(await screen.findByLabelText(/current password/i), 'owner123')
    await userEvent.type(screen.getByLabelText(/^new password$/i), 'a-fresh-secret')
    await userEvent.type(screen.getByLabelText(/confirm new password/i), 'a-fresh-secret')
    await userEvent.click(screen.getByRole('button', { name: /change password/i }))
await unlock()

    await waitFor(() =>
      expect(window.api.changeOwnerPassword).toHaveBeenCalledWith('owner123', 'a-fresh-secret'),
    )
  })

  it('will not submit a password change when the two new entries disagree', async () => {
    await openSettings()

    await userEvent.type(await screen.findByLabelText(/current password/i), 'owner123')
    await userEvent.type(screen.getByLabelText(/^new password$/i), 'a-fresh-secret')
    await userEvent.type(screen.getByLabelText(/confirm new password/i), 'a-fresh-secrets')

    expect(screen.getByRole('button', { name: /change password/i })).toBeDisabled()
    expect(window.api.changeOwnerPassword).not.toHaveBeenCalled()
  })

  /** There is no reset-by-email, no admin console, nothing. Saying so on the panel is the only warning anyone gets. */
  it('warns that a forgotten Owner password cannot be recovered', async () => {
    await openSettings()

    expect(await screen.findByText(/no way to recover it/i)).toBeInTheDocument()
  })
})

/**
 * Google Drive backup and restore panels on the Settings screen (PHASE12.md
 * section 2).
 *
 * The `/settings` password gate itself is covered in `the Owner password gate`
 * block above, including the assertion that the screen behind the prompt never
 * mounts. These cases are about what the Owner can do once past it, and — for
 * restore — what they are stopped from doing by accident.
 */
describe('Settings screen — Google Drive backup', () => {
  async function openSettings() {
    await openApp()
    editHashTo('#/dashboard')
    await screen.findByRole('heading', { name: /today at a glance/i })
    editHashTo('#/settings')
    return screen.findByRole('heading', { name: /^settings$/i })
  }

  it('shows the connected account and the last successful backup', async () => {
    await openSettings()

    expect(await screen.findByText(/connected as shopowner@example\.com/i)).toBeInTheDocument()
    expect(screen.getByText(/last successful backup/i)).toBeInTheDocument()
  })

  it('renders the saved schedule rather than a hardcoded default', async () => {
    await openSettings()

    expect(await screen.findByLabelText(/daily backup time/i)).toHaveValue('21:00')
    expect(screen.getByLabelText(/also back up when the app closes/i)).toBeChecked()
  })

  it('saves an edited schedule', async () => {
    await openSettings()

    const time = await screen.findByLabelText(/daily backup time/i)
    fireEvent.change(time, { target: { value: '22:30' } })
    await userEvent.click(screen.getByLabelText(/also back up when the app closes/i))
    await userEvent.click(screen.getByRole('button', { name: /save schedule/i }))
await unlock()

    await waitFor(() =>
      expect(window.api.setBackupSchedule).toHaveBeenCalledWith({ timeOfDay: '22:30', onAppClose: false }),
    )
  })

  it('runs a manual backup and reports the file it wrote', async () => {
    await openSettings()
    vi.mocked(window.api.runBackupNow).mockResolvedValue({
      ok: true,
      driveFileId: 'drive-file-3',
      fileName: 'swastik-backup-2026-08-26-0930.db',
      sizeBytes: 82000,
      error: null,
    })

    await userEvent.click(await screen.findByRole('button', { name: /backup now/i }))
await unlock()

    await waitFor(() => expect(window.api.runBackupNow).toHaveBeenCalled())
    expect(await screen.findByText(/backed up swastik-backup-2026-08-26-0930\.db/i)).toBeInTheDocument()
  })

  /**
   * A failed backup resolves rather than rejecting — it is an ordinary outcome
   * with a reason worth showing where the Owner is already looking.
   */
  it('shows why a manual backup failed instead of a generic error', async () => {
    await openSettings()
    vi.mocked(window.api.runBackupNow).mockResolvedValue({
      ok: false,
      driveFileId: null,
      fileName: 'swastik-backup-2026-08-26-0930.db',
      sizeBytes: null,
      error: 'Uploading the backup to Drive failed (HTTP 403): The user has exceeded their Drive quota.',
    })

    await userEvent.click(await screen.findByRole('button', { name: /backup now/i }))
await unlock()

    expect(await screen.findByText(/exceeded their Drive quota/i)).toBeInTheDocument()
  })

  /**
   * The reason `backup_log` has an `error` column at all. A panel that rendered
   * only successes would hide a run of quiet failures behind one old success —
   * the exact shape of problem this project already debugged twice in the
   * WhatsApp send path.
   */
  it('lists past failures with their reason, not just successes', async () => {
    await openSettings()

    expect(await screen.findByText(/rate limit exceeded/i)).toBeInTheDocument()
    expect(screen.getByText('swastik-backup-2026-08-25-2100.db')).toBeInTheDocument()
  })

  it('does not reach Google Drive merely because Settings was opened', async () => {
    await openSettings()
    await screen.findByText(/connected as shopowner@example\.com/i)

    // The restore list is fetched on request, not on mount.
    expect(window.api.listRestorePoints).not.toHaveBeenCalled()
    expect(window.api.connectDrive).not.toHaveBeenCalled()
  })
})

describe('Settings screen — restore', () => {
  async function openSettings() {
    await openApp()
    editHashTo('#/dashboard')
    await screen.findByRole('heading', { name: /today at a glance/i })
    editHashTo('#/settings')
    return screen.findByRole('heading', { name: /^settings$/i })
  }

  async function selectFirstRestorePoint() {
    await openSettings()
    await userEvent.click(await screen.findByRole('button', { name: /show available backups/i }))
    const row = (await screen.findByText('2026-08-25 21:00')).closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: /select/i }))
  }

  it('lists restore points dated from their snapshot names', async () => {
    await openSettings()

    await userEvent.click(await screen.findByRole('button', { name: /show available backups/i }))

    expect(await screen.findByText('2026-08-25 21:00')).toBeInTheDocument()
    expect(screen.getByText('2026-08-20 21:00')).toBeInTheDocument()
  })

  it('states exactly what a restore will destroy before offering to do it', async () => {
    await selectFirstRestorePoint()

    expect(await screen.findByText(/will replace all current data/i)).toBeInTheDocument()
    // Named individually rather than as one loose match: the warning lists
    // several distinct losses, and the point is that each is spelled out.
    expect(screen.getByText(/sale, payment, expense and customer/i)).toBeInTheDocument()
    expect(screen.getByText(/logins created since then/i)).toBeInTheDocument()
    expect(screen.getByText(/close and reopen/i)).toBeInTheDocument()
  })

  /**
   * The one irreversible-looking action in the app. A yes/no dialog gets
   * dismissed reflexively; typing the word does not.
   */
  it('keeps the restore button disabled until RESTORE is typed exactly', async () => {
    await selectFirstRestorePoint()

    const button = await screen.findByRole('button', { name: /restore from 2026-08-25 21:00/i })
    expect(button).toBeDisabled()

    const confirm = screen.getByLabelText(/type restore to confirm/i)
    await userEvent.type(confirm, 'restore')
    expect(button).toBeDisabled()

    await userEvent.clear(confirm)
    await userEvent.type(confirm, 'RESTORE')
    expect(button).toBeEnabled()
  })

  it('does not call restore while the confirmation is incomplete', async () => {
    await selectFirstRestorePoint()

    await userEvent.type(screen.getByLabelText(/type restore to confirm/i), 'REST')
    await userEvent.click(screen.getByRole('button', { name: /restore from 2026-08-25 21:00/i }))

    expect(window.api.restoreFromBackup).not.toHaveBeenCalled()
  })

  it('restores the selected snapshot once confirmed', async () => {
    await selectFirstRestorePoint()

    await userEvent.type(screen.getByLabelText(/type restore to confirm/i), 'RESTORE')
    await userEvent.click(screen.getByRole('button', { name: /restore from 2026-08-25 21:00/i }))
await unlock()

    await waitFor(() => expect(window.api.restoreFromBackup).toHaveBeenCalledWith('drive-file-2'))
  })

  it('reports a restore that could not be completed', async () => {
    await selectFirstRestorePoint()
    vi.mocked(window.api.restoreFromBackup).mockRejectedValue(
      new Error('That file is not a Swastik Collection backup — it is missing: sales.'),
    )

    await userEvent.type(screen.getByLabelText(/type restore to confirm/i), 'RESTORE')
    await userEvent.click(screen.getByRole('button', { name: /restore from 2026-08-25 21:00/i }))
await unlock()

    expect(await screen.findByText(/not a Swastik Collection backup/i)).toBeInTheDocument()
  })
})

/**
 * The retention panel (PHASE12.md section 3) — the Owner's view of the only
 * feature in the app that destroys data.
 *
 * The cases below are mostly about restraint: that it ships off, that it will
 * not run while it is off, and that the safeguard's held-back count is visible
 * rather than buried.
 */
describe('Settings screen — old bill clean-up', () => {
  /**
   * `loginAs` replaces `window.api` wholesale, so a mock set before it is
   * thrown away. `adjust` runs after login and before the screen mounts, which
   * is the only window in which a per-test payload survives.
   */
  async function openSettings(adjust?: () => void) {
    await openApp()
    editHashTo('#/dashboard')
    await screen.findByRole('heading', { name: /today at a glance/i })
    adjust?.()
    editHashTo('#/settings')
    return screen.findByRole('heading', { name: /^settings$/i })
  }

  function panel() {
    return within(screen.getByRole('heading', { name: /old bill clean-up/i }).closest('section')!)
  }

  /**
   * The single most important assertion in this block. Shipping the destructive
   * job switched on would make the decision for the shop on first launch.
   */
  it('ships switched off, with the run button unavailable', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: /old bill clean-up/i })

    expect(panel().getByLabelText(/automatically remove old bills/i)).not.toBeChecked()
    expect(panel().getByRole('button', { name: /run clean-up now/i })).toBeDisabled()
    expect(window.api.runRetention).not.toHaveBeenCalled()
  })

  /** PHASE12.md section 4's plain label: stated once, beside the setting, with "permanently" unsoftened. */
  it('states the retention rule plainly, including that deletion is permanent', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: /old bill clean-up/i })

    expect(panel().getByText(/permanently deleted after/i)).toBeInTheDocument()
    expect(panel().getByText(/cannot be undone/i)).toBeInTheDocument()
    expect(panel().getByText(/credit bills are never removed/i)).toBeInTheDocument()
  })

  /**
   * The safeguard's visible output. A count that climbs here means Drive
   * backups are failing and those bills exist nowhere else.
   */
  it('shows how many old bills are being held back for want of a backup', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: /old bill clean-up/i })

    expect(panel().getByText(/waiting for a backup/i)).toBeInTheDocument()
    expect(panel().getByText(/1 old bill\(s\) are being kept/i)).toBeInTheDocument()
  })

  it('previews without changing anything', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: /old bill clean-up/i })

    await userEvent.click(panel().getByRole('button', { name: /preview what would be removed/i }))

    expect(await screen.findByText(/nothing has been changed/i)).toBeInTheDocument()
    expect(window.api.runRetention).not.toHaveBeenCalled()
    expect(window.api.setRetentionEnabled).not.toHaveBeenCalled()
  })

  it('turns the job on through its own channel', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: /old bill clean-up/i })

    await userEvent.click(panel().getByLabelText(/automatically remove old bills/i))
await unlock()

    await waitFor(() => expect(window.api.setRetentionEnabled).toHaveBeenCalledWith(true))
  })

  it('runs the clean-up once enabled and reports what it removed', async () => {
    await openSettings(() => {
      vi.mocked(window.api.previewRetention).mockResolvedValue({ ...RETENTION_PREVIEW, enabled: true })
      vi.mocked(window.api.runRetention).mockResolvedValue({
        purgedLocally: 2,
        heldBack: 1,
        snapshotsDeleted: 1,
        error: null,
      })
    })
    await screen.findByRole('heading', { name: /old bill clean-up/i })

    // Wait for preview to load and button to be enabled
    const runButton = await screen.findByRole('button', { name: /run clean-up now/i })
    await waitFor(() => expect(runButton).not.toBeDisabled())
    await userEvent.click(runButton)
    await unlock()

    await waitFor(() => expect(window.api.runRetention).toHaveBeenCalled())
    expect(await screen.findByText(/removed 2 bill\(s\) from this computer/i)).toBeInTheDocument()
  })

  /** A Drive failure must not read as though the local half went wrong too — it did not. */
  it('reports a Drive sweep failure without claiming the whole run failed', async () => {
    await openSettings(() => {
      vi.mocked(window.api.previewRetention).mockResolvedValue({ ...RETENTION_PREVIEW, enabled: true })
      vi.mocked(window.api.runRetention).mockResolvedValue({
        purgedLocally: 2,
        heldBack: 1,
        snapshotsDeleted: 0,
        error: 'The local purge succeeded, but the Drive sweep did not: network unreachable',
      })
    })
    await screen.findByRole('heading', { name: /old bill clean-up/i })

    const runButton = await screen.findByRole('button', { name: /run clean-up now/i })
    await waitFor(() => expect(runButton).not.toBeDisabled())
    await userEvent.click(runButton)
    await unlock()

    expect(await screen.findByText(/the local purge succeeded/i)).toBeInTheDocument()
  })

  /**
   * Past the 60-day deadline and never backed up. The safeguard keeps them, and
   * the Owner is told why rather than left to notice a number that never falls.
   */
  it('warns loudly about bills past their deletion date that were never backed up', async () => {
    await openSettings(() => {
      vi.mocked(window.api.previewRetention).mockResolvedValue({
        ...RETENTION_PREVIEW,
        overdueNeverBackedUp: [{ id: 31, created_at: '2026-04-01 10:00:00', purge_at: '2026-06-30 10:00:00' }],
      })
    })

    expect(await screen.findByText(/past their deletion date but have never/i)).toBeInTheDocument()
    expect(panel().getByText(/deleting them would destroy the only copy/i)).toBeInTheDocument()
  })

  it('lists what has been removed, without any money against it', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: /old bill clean-up/i })

    expect(panel().getByText('Bill #7')).toBeInTheDocument()
    expect(panel().getByText(/swastik-backup-2026-05-20-2100\.db/)).toBeInTheDocument()
  })
})

/**
 * The Reports note (PHASE12.md section 3).
 *
 * Once bills really are gone, a long report under-reports cash sales. Saying so
 * is the difference between "that is the retention rule" and "the app lost my
 * sales".
 */
describe('Reports — retention note', () => {
  async function openReports(adjust?: () => void) {
    await openApp()
    editHashTo('#/dashboard')
    await screen.findByRole('heading', { name: /today at a glance/i })
    adjust?.()
    editHashTo('#/reports')
    return screen.findByRole('heading', { name: /^reports$/i })
  }

  it('says nothing while no bill has ever been purged', async () => {
    await openReports()
    await screen.findByText('₹18,400.00')

    expect(screen.queryByText(/retention rule/i)).not.toBeInTheDocument()
  })

  it('explains the gap when the range reaches back past the cutoff', async () => {
    // The cutoff sits *inside* the report's range (which starts 2026-08-01), so
    // the earlier part of the window really is missing cash bills. A cutoff
    // equal to `range.from` would mean nothing is missing, and the note would
    // correctly stay hidden.
    await openReports(() => {
      vi.mocked(window.api.getDailySalesReport).mockResolvedValue({
        ...DAILY_SALES_REPORT,
        cashRetentionCutoff: '2026-08-10',
      })
    })

    expect(await screen.findByText(/have been removed under the 60-day retention rule/i)).toBeInTheDocument()
    // Settled credit bills follow the same rule, and the note says so — otherwise an Owner would
    // reasonably wonder whether what they are owed is missing too.
    expect(screen.getByText(/credit bills that customers have fully paid off/i)).toBeInTheDocument()
  })

  it('stays quiet when the range sits entirely inside the retained window', async () => {
    await openReports(() => {
      vi.mocked(window.api.getDailySalesReport).mockResolvedValue({
        ...DAILY_SALES_REPORT,
        range: { from: '2026-08-20', to: '2026-08-24' },
        cashRetentionCutoff: '2026-08-01',
      })
    })
    await screen.findByText('₹18,400.00')

    expect(screen.queryByText(/retention rule/i)).not.toBeInTheDocument()
  })
})

/**
 * Full sales-history export (PHASE12.md section 4) — the Owner's way out of the
 * retention rule, which is why it sits beside it on the Settings screen.
 */
describe('Settings screen — export sales history', () => {
  async function openSettings(adjust?: () => void) {
    await openApp()
    editHashTo('#/dashboard')
    await screen.findByRole('heading', { name: /today at a glance/i })
    adjust?.()
    editHashTo('#/settings')
    return screen.findByRole('heading', { name: /^settings$/i })
  }

  function panel() {
    return within(screen.getByRole('heading', { name: /export sales history/i }).closest('section')!)
  }

  it('is reachable from Settings and explains what it is for', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: /export sales history/i })

    expect(panel().getByRole('button', { name: /export full sales history/i })).toBeInTheDocument()
    // The reason it exists, per section 4: a way to keep things permanently
    // before the retention rule removes them.
    expect(panel().getByText(/before it is removed under the 60-day rule/i)).toBeInTheDocument()
  })

  it('exports and reports what was written and where', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: /export sales history/i })

    await userEvent.click(panel().getByRole('button', { name: /export full sales history/i }))

    await waitFor(() => expect(window.api.exportSalesHistory).toHaveBeenCalled())
    expect(await screen.findByText(/saved 22 bill\(s\) across 31 item row\(s\)/i)).toBeInTheDocument()
  })

  /** A dismissed save dialog is a choice, not a failure — the same treatment the Phase 11 exports and the print path give it. */
  it('says nothing when the save dialog is dismissed', async () => {
    await openSettings(() => {
      vi.mocked(window.api.exportSalesHistory).mockResolvedValue({
        saved: false,
        filePath: null,
        saleCount: 22,
        rowCount: 31,
      })
    })
    await screen.findByRole('heading', { name: /export sales history/i })

    await userEvent.click(panel().getByRole('button', { name: /export full sales history/i }))

    await waitFor(() => expect(window.api.exportSalesHistory).toHaveBeenCalled())
    // Scoped to this panel: the Drive panel legitimately renders a "Saved — type
    // to replace" placeholder, and a page-wide match would collide with it.
    expect(panel().queryByText(/saved/i)).not.toBeInTheDocument()
  })

  it('does not export merely because Settings was opened', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: /export sales history/i })

    expect(window.api.exportSalesHistory).not.toHaveBeenCalled()
  })

  it('surfaces a failure rather than appearing to have saved', async () => {
    await openSettings(() => {
      vi.mocked(window.api.exportSalesHistory).mockRejectedValue(new Error('EACCES: permission denied'))
    })
    await screen.findByRole('heading', { name: /export sales history/i })

    await userEvent.click(panel().getByRole('button', { name: /export full sales history/i }))

    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument()
  })
})
