import electron from 'electron'
import type { BrowserWindow as BrowserWindowType, IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../src/db/db.js'
import { getCounterUser, verifyOwnerPassword } from './auth.js'
import { clearSession, getSession, setSession } from './session.js'
import { clearUnlockFailures, delay, recordUnlockFailure, unlockDelayMs } from './unlockThrottle.js'
import { createParty, deleteParty, getParties, getPartyById, getPartyLedger, quickAddParty, updateParty } from '../src/db/parties.js'
import type { CreatePartyInput, PartyListFilters, QuickAddPartyInput, UpdatePartyInput } from '../src/types/party.js'
import type { SafeUser } from '../src/types/user.js'
import { createBarcodeLabel, getBarcodeLabels } from '../src/db/barcodeLabels.js'
import type { BarcodeLabelListFilters, CreateBarcodeLabelInput } from '../src/types/barcodeLabel.js'
import { assertSalePrintable, createSale, getSaleById, markSalePrinted, usePrintOverride } from '../src/db/sales.js'
import type { CreateSaleInput } from '../src/types/sale.js'
import { recordPayment } from '../src/db/payments.js'
import type { RecordPaymentInput } from '../src/types/payment.js'
import { getExpenses, logExpense } from '../src/db/expenses.js'
import type { ExpenseListFilters, LogExpenseInput } from '../src/types/expense.js'
import {
  getDailySalesReport,
  getOwnerDashboard,
  getPartyOutstandingReport,
  getSalesLedger,
  getSalesmanReport,
  getSalesmanSales,
} from '../src/db/reports.js'
import type { DateRange } from '../src/types/report.js'
import { assertValidRange, todayRange } from '../src/lib/dateRange.js'
import { getLabelSize, getShopSettings, setLabelSize, setShopSettings } from '../src/db/settings.js'
import type { LabelSize, ShopSettingsInput } from '../src/types/settings.js'
import { changeOwnerPassword } from '../src/db/users.js'
import { createSalesman, listSalesmen, renameSalesman, setSalesmanActive } from '../src/db/salesmen.js'
import type { UnlockResult } from '../src/types/user.js'
import type { SalesmanListFilters } from '../src/types/salesman.js'
import { exportFullSalesHistory } from '../src/db/salesExport.js'
import {
  connectDrive,
  disconnectDrive,
  getBackupStatus,
  listRestorePoints,
  restoreFromBackup,
  runBackup,
  runOnCloseBackupIfDue,
  saveBackupSchedule,
  saveDriveCredentials,
  startBackupScheduler,
  stopBackupScheduler,
} from './backup/service.js'
import type { BackupSchedule } from '../src/types/backup.js'
import {
  getPurgeHistory,
  previewRetention,
  runRetention,
  setRetention,
  startRetentionScheduler,
  stopRetentionScheduler,
} from './retention/service.js'
import { assertPermission } from '../src/db/permissions.js'
import {
  connectToAgent,
  disconnectFromAgent,
  getAgentState,
  onAgentMessageAck,
  onAgentStateChange,
  requestAgentConnect,
  requestAgentLogout,
} from './agent/client.js'
import { runWhatsAppAgent } from './agent/server.js'
import { AGENT_ARGV_FLAG } from './agent/protocol.js'
import { retryPendingBills, sendSaleWhatsAppNotifications } from './whatsapp/send.js'
import {
  countSalesAwaitingWhatsApp,
  getCustomerBillDeliveries,
  updateWhatsAppAckByMessageId,
} from '../src/db/whatsappLog.js'
import { WHATSAPP_WEB_PARTITION } from '../src/types/whatsapp.js'
import type { WhatsAppState, WhatsAppStatus } from '../src/types/whatsapp.js'

const { app, BrowserWindow, dialog, ipcMain, session, shell } = electron

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Populated by vite-plugin-electron in dev; undefined in a packaged build.
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

let mainWindow: BrowserWindowType | null = null
/** Previous agent status, so the queued-bill retry fires on the *transition* into `connected` rather than on every repeat of it. */
let lastAgentStatus: WhatsAppStatus | null = null

/** Throws if `event`'s sender has no server-tracked session — i.e. no successful `auth:login` on record for it. */
function requireSession(event: IpcMainInvokeEvent): SafeUser {
  const user = getSession(event.sender.id)
  if (!user) throw new Error('Not authenticated')
  return user
}

/** Raised when the operator dismissed the print dialog — a normal outcome, not a fault, so callers can report it gently and leave `printed` false. */
const PRINT_CANCELLED = 'PRINT_CANCELLED'

/**
 * Prints the renderer's current page through the main process.
 *
 * Electron does **not** ship Chromium's print-preview UI, so calling
 * `window.print()` from the renderer (which is what Phases 4 and 7 originally
 * did) opens a stub window reading "This app doesn't support print preview"
 * and never reaches a printer. `webContents.print()` is the supported API and
 * goes straight to the real system print dialog.
 *
 * Both print paths in this app — the bill (`sale:print`) and Phase 4's
 * barcode labels (`print:page`) — funnel through here, so neither can drift
 * back to the broken call. What actually gets printed is still decided by the
 * `@media print` rules in src/index.css: only the `.print-sheet` element is
 * visible, exactly as before.
 */
function printWebContents(contents: Electron.WebContents): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      contents.print({ silent: false, printBackground: true }, (success, failureReason) => {
        if (success) return resolve()
        // Electron reports a dismissed dialog as a failure with this reason;
        // it isn't an error worth alarming the person at the counter with.
        if (/cancel/i.test(failureReason ?? '')) return reject(new Error(PRINT_CANCELLED))
        reject(new Error(failureReason || 'The printer did not accept the job.'))
      })
    } catch (err: unknown) {
      // print() throws synchronously when there's no printer configured at all.
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * A plain Chrome user agent for the embedded WhatsApp Web view.
 *
 * Electron's default UA carries an `Electron/43.4.1` token and the app's own
 * name; web.whatsapp.com reads the UA to decide whether it's talking to a
 * supported browser, and an unrecognised one gets the "update your browser"
 * wall instead of the client. The Chromium version is the real one this
 * Electron build ships, so the claim stays true as Electron moves.
 */
function whatsAppWebUserAgent(): string {
  const platformToken =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Windows NT 10.0; Win64; x64'
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
}

/** Permissions the embedded WhatsApp Web view is allowed to ask for. Voice notes and attachments need these; anything else (notifications, geolocation) is denied outright rather than interrupting whoever is at the counter with an OS prompt. */
const WHATSAPP_WEB_PERMISSIONS = new Set<string>([
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
])

function configureWhatsAppWebSession(): void {
  const whatsappSession = session.fromPartition(WHATSAPP_WEB_PARTITION)
  // Set on the partition rather than the <webview useragent> attribute so it
  // applies to every request the view makes from the very first load,
  // however and whenever the component mounts.
  whatsappSession.setUserAgent(whatsAppWebUserAgent())
  whatsappSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(WHATSAPP_WEB_PERMISSIONS.has(permission))
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Enables the <webview> tag used by the Connect WhatsApp screen to host
      // the real web.whatsapp.com. It stays inside its own persistent session
      // partition with no preload and no node access of its own, so the page
      // it loads can reach nothing of this app's.
      webviewTag: true,
    },
  })

  const senderId = mainWindow.webContents.id

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    clearSession(senderId)
    mainWindow = null
  })
}

/**
 * This binary runs as one of two things.
 *
 * With `--wa-agent` it is the WhatsApp session holder: no window, no database,
 * started at login and left running so the linked session survives the billing
 * window opening and closing. See agent/protocol.ts for why that split exists.
 * Everything below the early return is the billing app.
 */
const isAgentMode = process.argv.includes(AGENT_ARGV_FLAG)

/**
 * One billing window per machine.
 *
 * Windows makes a second one easy to open by accident — a second double-click
 * on the shortcut is enough — and the shop machine was running two at once
 * when the *"The browser is already running for …\wwebjs_auth\session"* error
 * was captured, both started in the same second. Two instances race to own the
 * WhatsApp session, and the loser's Chrome cannot open a profile the winner's
 * already holds. They also both hold `app.db` open, which the whole design
 * assumes exactly one process does.
 *
 * CLAUDE.md recorded this lock as deliberately **not** added, on the grounds
 * that the app and the agent share a `userData` directory and would collide
 * over it. That is only true of processes that *ask* for it: the agent never
 * does, and `isAgentMode` is what keeps it that way. Packaged builds only, so
 * a dev instance can still run alongside the installed app.
 */
const isSecondInstance = !isAgentMode && app.isPackaged && !app.requestSingleInstanceLock()
if (isSecondInstance) app.quit()

app.whenReady().then(async () => {
  if (isAgentMode) {
    await runWhatsAppAgent()
    return
  }

  // Nothing below this line may run twice — not the database, not the
  // schedulers, and above all not a second race for the WhatsApp session.
  if (isSecondInstance) {
    app.quit()
    return
  }

  // Whoever tried to open the second window wanted to see this one.
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  getDb()
  configureWhatsAppWebSession()
  // Keeps the session warm across app restarts — reusing a running agent when
  // there is one (the common case, and the one that skips the offline-backlog
  // resync entirely) and starting one when there isn't. Not awaited: a slow
  // agent start must never hold up the billing window.
  connectToAgent()
  registerAgentAutostart()

  // Checks at launch and every 15 minutes thereafter. The launch check is what
  // makes a missed slot catch up rather than vanish: a machine switched off at
  // 21:00 would otherwise answer "it isn't 21:00" at every check and the shop
  // would go weeks without a backup while Settings said "daily". That matters
  // beyond tidiness — PHASE12.md section 3 gates the irreversible day-30 local
  // purge on a successful backup existing.
  startBackupScheduler(getDb())

  // Started here but inert until an Owner switches it on: `retention_enabled`
  // defaults to off, and every pass checks it first. PHASE12.md section 3 wants
  // the job to run on launch *and* on an interval, since a shop that leaves the
  // app open for days would otherwise never trigger it.
  startRetentionScheduler(getDb())

  // A link tapped inside a WhatsApp chat should open in the person's real
  // browser, not in a chrome-less Electron window they can't navigate out of.
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    // Belt and braces alongside the session-level user agent: the guest's own
    // WebContents gets it too, so WhatsApp Web can never see an `Electron/...`
    // token and answer with its unsupported-browser wall.
    contents.setUserAgent(whatsAppWebUserAgent())
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  /**
   * Establishes this window's baseline session — the counter (client decision,
   * 2026-08-27: "remove salesman login").
   *
   * There is no login form any more, so *something* has to answer "who is
   * calling" for every handler below, and CLAUDE.md's rule that the answer
   * comes from the main process and never from a renderer argument did not
   * change. This is that answer. It takes no arguments and reads the reserved
   * `__counter__` row from the database, so a patched renderer cannot name who
   * it starts as any more than it could forge a login before.
   *
   * The counter's role is `salesman`, so the Phase 2 PERMISSIONS table decides
   * what an un-elevated window may do — unchanged, and still enforced inside
   * every write function rather than here.
   */
  ipcMain.handle('auth:start', (event): SafeUser => {
    const counter = getCounterUser(getDb())
    setSession(event.sender.id, counter)
    return counter
  })

  /**
   * Raises this window to the Owner for as long as an Owner-only module is
   * open, on a correct Owner password.
   *
   * **This is a real privilege change, not a UI flag**, and that is the entire
   * design: the session map now holds an Owner, so every subsequent call from
   * this window passes `report:view_all`, `settings:edit` and the rest because
   * it genuinely is the Owner — while a renderer that drew its own dialog and
   * skipped this channel is still the counter and still gets a
   * `PermissionError` out of the data layer. The gate cannot be patched out of
   * the renderer because the renderer was never where it lived.
   *
   * The password is checked against `users` here, so no hash ever crosses IPC
   * (`verifyOwnerPassword`, electron/auth.ts). A miss is throttled per window
   * — the app now sits open at a counter all day, so unlimited instant guesses
   * would make this no gate at all (electron/unlockThrottle.ts). The wait is
   * served *before* the attempt is considered, so hammering the button cannot
   * outrun it.
   */
  ipcMain.handle('auth:unlock', async (event, password: string): Promise<UnlockResult> => {
    const wait = unlockDelayMs(event.sender.id)
    if (wait > 0) await delay(wait)

    const owner = typeof password === 'string' ? verifyOwnerPassword(getDb(), password) : null
    if (!owner) {
      recordUnlockFailure(event.sender.id)
      return {
        ok: false,
        error: 'That password is not correct.',
        retryAfterMs: unlockDelayMs(event.sender.id),
      }
    }

    clearUnlockFailures(event.sender.id)
    setSession(event.sender.id, owner)
    return { ok: true, user: owner }
  })

  /**
   * Drops this window back to the counter.
   *
   * Called when an Owner-only screen unmounts — the client chose "locks as soon
   * as you leave the module" — and idempotent, so calling it while already
   * locked is fine. It re-reads the counter row rather than restoring a
   * remembered one, so a Drive restore that replaced `app.db` underneath cannot
   * leave this pointing at an id that now means someone else.
   */
  ipcMain.handle('auth:lock', (event): SafeUser => {
    const counter = getCounterUser(getDb())
    setSession(event.sender.id, counter)
    return counter
  })

  // Read-only for now (PHASE3.md prompt 1) — both roles can view per the
  // section 2 permission table, so no assertPermission gate is needed beyond
  // requiring an actual logged-in session.
  ipcMain.handle('parties:list', (event, filters?: PartyListFilters) => {
    requireSession(event)
    return getParties(getDb(), filters)
  })
  ipcMain.handle('parties:ledger', (event, partyId: number) => {
    requireSession(event)
    return getPartyLedger(getDb(), partyId)
  })

  // Write operations (PHASE3.md prompt 2). Each function calls assertPermission
  // first, so a PermissionError here propagates to the renderer as a rejected
  // promise rather than silently succeeding. `requireSession(event)` looks up
  // who's actually logged in on this connection server-side — the renderer no
  // longer passes a `user` argument at all, so a modified/patched renderer
  // has nothing to forge: it can't claim a role it didn't authenticate as.
  ipcMain.handle('parties:create', (event, data: CreatePartyInput) =>
    createParty(getDb(), requireSession(event), data),
  )
  ipcMain.handle('parties:quickAdd', (event, data: QuickAddPartyInput) =>
    quickAddParty(getDb(), requireSession(event), data),
  )
  ipcMain.handle('parties:update', (event, id: number, data: UpdatePartyInput) =>
    updateParty(getDb(), requireSession(event), id, data),
  )
  ipcMain.handle('parties:delete', (event, id: number) => deleteParty(getDb(), requireSession(event), id))

  // Barcode generation (PHASE4.md prompt 1). Both roles can view and create
  // per section 6, so the list handler only needs requireSession — the
  // create handler's assertPermission call inside createBarcodeLabel is what
  // actually enforces the role check.
  ipcMain.handle('barcode:list', (event, filters?: BarcodeLabelListFilters) => {
    requireSession(event)
    return getBarcodeLabels(getDb(), filters)
  })
  ipcMain.handle('barcode:create', (event, data: CreateBarcodeLabelInput) =>
    createBarcodeLabel(getDb(), requireSession(event), data),
  )

  // Sale creation (PHASE5.md prompt 2). Follows the same session pattern as
  // every write channel above: `requireSession(event)` identifies the caller
  // from the main-process session store, never from a renderer-supplied
  // argument, so `createSale`'s `assertPermission` check can't be spoofed by
  // a modified renderer.
  //
  // Immediately after the sale is saved, the PHASE6.md section 3 WhatsApp
  // send fires automatically — no manual "send" button for the normal path.
  // Awaited here (rather than fired-and-forgotten) so the `SaleRecord`
  // returned to the renderer already reflects the resulting
  // whatsapp_customer_sent/whatsapp_owner_sent flags; re-fetched via
  // `getSaleById` since `sendSaleWhatsAppNotifications` mutates those flags
  // in the DB rather than returning an updated record itself.
  ipcMain.handle('sale:create', async (event, data: CreateSaleInput) => {
    const db = getDb()
    const sale = createSale(db, requireSession(event), data)
    const party = sale.party_id != null ? getPartyById(db, sale.party_id) : null
    await sendSaleWhatsAppNotifications(db, sale, party?.name ?? null, party?.phone ?? null)
    return getSaleById(db, sale.id)!
  })

  // Payment-In (PHASE8.md section 2). Same session pattern as every other
  // write channel — `requireSession(event)` identifies the caller, and
  // `recordPayment`'s own `assertPermission(role, 'payment:create')` is the
  // real role check (both roles are allowed, per section 4).
  //
  // Note what is deliberately absent, unlike `sale:create` directly above:
  // no `sendSaleWhatsAppNotifications` call and no print step. Payment-In is
  // explicitly NOT WhatsApp-gated (PHASE8.md section 0 / CLAUDE.md) — the
  // write is the entire flow, and the already-updated party record comes back
  // in the same response so the screen needs no refetch.
  ipcMain.handle('payment:create', (event, data: RecordPaymentInput) =>
    recordPayment(getDb(), requireSession(event), data),
  )

  // Expenses (PHASE9.md section 2). Both roles can view the list and log a new
  // expense per the section 3 table — the confirmed decision that reversed an
  // earlier Owner-only assumption — so the list handler only needs a session,
  // and `logExpense`'s own `assertPermission(role, 'expense:create')` is the
  // real role check on the write.
  //
  // Same session pattern as every other write channel: `requireSession(event)`
  // resolves who is actually logged in on this connection, so the expense is
  // attributed server-side and a modified renderer can neither claim a role
  // nor log an expense under someone else's name.
  //
  // Note there is deliberately no expense edit or delete channel here.
  // `expense:edit`/`expense:delete` exist in the PERMISSIONS table as
  // Owner-only, but PHASE9.md section 1 builds no UI for them, and adding an
  // IPC channel with nothing behind it would be a reachable path to a
  // half-built feature.
  ipcMain.handle('expense:list', (event, filters?: ExpenseListFilters) => {
    requireSession(event)
    return getExpenses(getDb(), filters)
  })
  ipcMain.handle('expense:create', (event, data: LogExpenseInput) =>
    logExpense(getDb(), requireSession(event), data),
  )

  // Dashboard (PHASE10.md sections 1-2). Read-only.
  //
  // One channel since 2026-08-27: its Salesman counterpart went with the
  // salesman login, and every figure here is now shop-wide.
  //
  // Gated, and that gate is what makes the Owner password prompt real:
  // `getOwnerDashboard` asserts `report:view_all` before it queries anything,
  // so a renderer that mounted this screen without unlocking is still the
  // counter session here and gets a PermissionError rather than the shop's
  // numbers. The three Owner-only query functions each assert it again.
  //
  // Neither channel takes a date range. "Today" is computed here with
  // `todayRange()` so the day is decided by one clock the renderer cannot
  // move, and so no call can fall back to `getExpensesTotal`'s all-time
  // default. Phase 11's Reports module is what introduces a caller-supplied
  // range — the query layer already takes one, so that is a parameter change
  // here and nothing more.
  ipcMain.handle('dashboard:owner', (event) =>
    getOwnerDashboard(getDb(), requireSession(event), todayRange()),
  )
  // `dashboard:salesman` stood here until 2026-08-27, answering one salesman's
  // own day. It went with the salesman login: no session is a salesman any
  // more, so there is nobody whose "own" day it could describe.

  // Reports (PHASE11.md sections 1-3). Read-only, Owner-only, and additive —
  // the two dashboard channels above are deliberately **untouched** by this
  // phase. They keep computing `todayRange()` main-side, which is what makes
  // acceptance criterion 1 meaningful: the Daily Sales Report narrowed to today
  // and the Owner dashboard reach the same query function down two independent
  // channels, so if they ever disagree, the generalized query has drifted.
  //
  // Every composer behind these asserts `report:view_all` before it queries, so
  // a Salesman renderer patched to invoke any of them gets a PermissionError
  // rather than data (PHASE11.md section 4, acceptance criterion 5). The route
  // guard in front of `/reports` is the second layer, not the only one.
  //
  // **Unlike the dashboard channels, these take a caller-supplied range**, so
  // each validates it first. The queries are parameterised — there is nothing
  // to inject — but a malformed end is worse than an error: `date(col,
  // 'localtime') >= 'garbage'` matches nothing and renders as a perfectly
  // plausible "no sales in this range", and an omitted range means *all time*.
  // Both are wrong answers wearing the costume of right ones, so
  // `assertValidRange` rejects them loudly.
  ipcMain.handle('reports:dailySales', (event, range: DateRange) => {
    const user = requireSession(event)
    assertValidRange(range)
    return getDailySalesReport(getDb(), user, range)
  })
  ipcMain.handle('reports:salesmanBreakdown', (event, range: DateRange) => {
    const user = requireSession(event)
    assertValidRange(range)
    return getSalesmanReport(getDb(), user, range)
  })
  // `salesmanId` **is** a renderer-supplied argument, and that does not
  // conflict with CLAUDE.md's IPC identity rule. That rule forbids a caller
  // claiming a `user`/`role`; this is a filter choosing whose rows to display,
  // which is the Owner's whole job on this screen. Who is asking still comes
  // from `requireSession`, and `report:view_all` still gates the answer — so
  // the worst a patched renderer achieves here is asking for a different
  // salesman's sales, which any Owner can already do by clicking a row.
  //
  // Null is a legitimate value, not a missing one: it selects the unassigned
  // bucket. Coerced explicitly so an `undefined` arriving over IPC is read as
  // that bucket rather than reaching the query as a stray argument.
  ipcMain.handle('reports:salesmanSales', (event, salesmanId: number | null, range: DateRange) => {
    const user = requireSession(event)
    assertValidRange(range)
    return getSalesmanSales(getDb(), user, salesmanId ?? null, range)
  })
  // The Sales module's flat bill list (client request, 2026-08-27). Same
  // validation and the same gate as its neighbours above — it reads the same
  // rows `reports:salesmanBreakdown` totals, so it must not be reachable on
  // easier terms than that one.
  ipcMain.handle('reports:salesLedger', (event, range: DateRange) => {
    const user = requireSession(event)
    assertValidRange(range)
    return getSalesLedger(getDb(), user, range)
  })
  // No range: a live snapshot of what every party owes right now, the same
  // figure the dashboard's "Outstanding Credit" card shows (PHASE11.md section
  // 1 — "this is a live snapshot (not date-ranged)").
  ipcMain.handle('reports:partyOutstanding', (event) =>
    getPartyOutstandingReport(getDb(), requireSession(event)),
  )

  /**
   * Saves an already-built CSV to a file the Owner picks (PHASE11.md section 2).
   *
   * **The renderer sends finished text; this handler does not query anything.**
   * That is the design, not laziness: acceptance criterion 4 requires the file
   * to match the on-screen numbers exactly, and a main-side re-query could pick
   * up a sale that landed between the render and the click — producing a file
   * that is *more current* than the screen and therefore wrong by the only
   * definition that matters here.
   *
   * Gated by `report:view_all` per section 4's export row, so this is Owner-only
   * like everything else in the module. It is also the first thing in this app
   * to write a file outside SQLite and the print path, which is why the
   * permission check is explicit here rather than inherited from a query.
   *
   * A dismissed dialog resolves `{saved: false}` rather than throwing — the
   * operator changing their mind is a normal outcome, the same way
   * `printWebContents` treats a cancelled print dialog.
   */
  ipcMain.handle('reports:exportCsv', async (event, defaultFileName: string, csvText: string) => {
    const user = requireSession(event)
    assertPermission(user.role, 'report:view_all')

    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await (window
      ? dialog.showSaveDialog(window, {
          defaultPath: defaultFileName,
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        })
      : dialog.showSaveDialog({
          defaultPath: defaultFileName,
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        }))

    if (result.canceled || !result.filePath) return { saved: false, filePath: null }

    // 'utf8' and not 'utf8' + a manual BOM: `toCsv` already prefixes the BOM,
    // because it is part of the document Excel has to read, not part of how it
    // reaches disk.
    fs.writeFileSync(result.filePath, csvText, 'utf8')
    return { saved: true, filePath: result.filePath }
  })

  // Print gate wiring (PHASE7.md section 2). Both roles can print once
  // `markSalePrinted` confirms the gate is actually satisfied — the real
  // enforcement lives there (`canPrintSale`, src/lib/printGate.ts), not
  // here, so a modified renderer calling this channel directly still can't
  // reach a printed=true state early. The Owner-only override goes through
  // its own `sale:print_override` permission inside `usePrintOverride`.
  // Gate first, then print, then record it. `printed` is only ever set after
  // the printer actually accepted the job, so a cancelled dialog leaves the
  // sale unprinted and re-printable rather than falsely marked done.
  ipcMain.handle('sale:print', async (event, saleId: number) => {
    const db = getDb()
    const user = requireSession(event)
    assertSalePrintable(db, user, saleId)

    await printWebContents(event.sender)

    return markSalePrinted(db, user, saleId)
  })
  // Ungated page print, used by Phase 4's barcode labels — both roles print
  // labels, and unlike a bill there's no WhatsApp gate involved.
  ipcMain.handle('print:page', (event) => {
    requireSession(event)
    return printWebContents(event.sender)
  })
  ipcMain.handle('sale:printOverride', (event, saleId: number) =>
    usePrintOverride(getDb(), requireSession(event), saleId),
  )

  // Label Size setting (Barcode Generator "Label Size Settings" panel). Both
  // roles print labels, so the read side only needs requireSession; the
  // write side's Owner-only enforcement lives in setLabelSize's
  // assertPermission call, same pattern as every other write channel above.
  ipcMain.handle('settings:getLabelSize', (event) => {
    requireSession(event)
    return getLabelSize(getDb())
  })
  ipcMain.handle('settings:setLabelSize', (event, size: LabelSize) =>
    setLabelSize(getDb(), requireSession(event), size),
  )

  // Shop details + the Owner's WhatsApp number (PHASE12.md section 1). These
  // rows replace the hardcoded constants Phases 6 and 7 shipped with
  // (src/lib/shopInfo.ts and electron/whatsapp/config.ts, both now deleted),
  // and both the printed bill and the WhatsApp bill image read them, so the
  // two can no longer drift apart.
  //
  // Same read/write split as label size directly above: the read only needs a
  // session, because a Salesman prints bills and this is the bill header; the
  // write's Owner-only enforcement is `settings:edit` inside `setShopSettings`,
  // not a check here.
  ipcMain.handle('settings:getShop', (event) => {
    requireSession(event)
    return getShopSettings(getDb())
  })
  ipcMain.handle('settings:setShop', (event, input: ShopSettingsInput) =>
    setShopSettings(getDb(), requireSession(event), input),
  )

  // Salesman names (2026-08-27), replacing Phase 12's salesman-login channels
  // (`users:list` / `users:createSalesman` / `users:setActive` /
  // `users:resetPassword`, all removed — a salesman has no login to administer).
  //
  // Same session pattern as every other write channel: `requireSession(event)`
  // resolves who is actually calling, so a patched renderer can neither claim
  // to be an Owner nor write under someone else's authority.
  //
  // **There is deliberately no delete channel here**, and no delete function
  // behind one — the rule Phase 12 stated for logins, carried over for the same
  // reason. A `salesmen` row is referenced by every bill that person rang up;
  // removing one would strip the attribution off all of it. Retiring somebody
  // goes through `salesmen:setActive`, which only ever flips `is_active`.
  //
  // The list is ungated beyond a session, like `parties:list` — the sale
  // screen's dropdown runs at the counter and needs it. The three writes assert
  // `salesman:manage` inside each function, so a counter session invoking them
  // directly gets a PermissionError.
  ipcMain.handle('salesmen:list', (event, filters?: SalesmanListFilters) => {
    requireSession(event)
    return listSalesmen(getDb(), filters)
  })
  ipcMain.handle('salesmen:create', (event, name: string) =>
    createSalesman(getDb(), requireSession(event), name),
  )
  ipcMain.handle('salesmen:rename', (event, id: number, name: string) =>
    renameSalesman(getDb(), requireSession(event), id, name),
  )
  ipcMain.handle('salesmen:setActive', (event, id: number, isActive: boolean) =>
    setSalesmanActive(getDb(), requireSession(event), id, isActive),
  )

  // Whose password gets changed comes from `requireSession`, never from an id
  // the renderer supplies — there is no way to point this at another row.
  ipcMain.handle('users:changeOwnerPassword', (event, currentPassword: string, newPassword: string) =>
    changeOwnerPassword(getDb(), requireSession(event), currentPassword, newPassword),
  )

  // Google Drive backup (PHASE12.md section 2). Owner-only throughout, via
  // `backup:run` and `backup:restore` — both of which have been in the Phase 2
  // PERMISSIONS table as placeholders since it was written, so **no new Action
  // was added and the harness stays at 46 checks**; they finally have callers.
  //
  // Same session pattern as every other write channel: `requireSession(event)`
  // resolves who is actually logged in, and the assert lives inside each
  // service function rather than here.
  //
  // `backup:runNow` deliberately **resolves with a result rather than
  // rejecting** on failure. A failed backup is a normal outcome worth showing
  // in place with its reason (and it has already been written to `backup_log`),
  // not an exception for the renderer to turn into a generic error toast.
  ipcMain.handle('backup:getStatus', (event) => getBackupStatus(getDb(), requireSession(event)))
  ipcMain.handle('backup:setCredentials', (event, input: { clientId: string; clientSecret: string }) =>
    saveDriveCredentials(getDb(), requireSession(event), input),
  )
  ipcMain.handle('backup:connect', (event) => connectDrive(getDb(), requireSession(event)))
  ipcMain.handle('backup:disconnect', (event) => disconnectDrive(getDb(), requireSession(event)))
  ipcMain.handle('backup:setSchedule', (event, schedule: BackupSchedule) =>
    saveBackupSchedule(getDb(), requireSession(event), schedule),
  )
  ipcMain.handle('backup:runNow', (event) => runBackup(getDb(), requireSession(event), 'manual'))
  ipcMain.handle('backup:listRestorePoints', (event) => listRestorePoints(getDb(), requireSession(event)))
  // Does not resolve on success — `restoreFromBackup` relaunches the app once
  // the swap is done, because every open screen holds rows from the database
  // that was just replaced.
  ipcMain.handle('backup:restore', (event, driveFileId: string) =>
    restoreFromBackup(getDb(), requireSession(event), driveFileId),
  )

  // The retention/purge job (PHASE12.md section 3) — Owner-only via the new
  // `retention:run` action. This is the most destructive surface in the app, so
  // it gets its own permission rather than borrowing `backup:run`: an audit
  // trail in which a *backup* appeared to delete the shop's records would be
  // actively misleading.
  //
  // `retention:preview` is read-only by contract and is what makes an
  // irreversible delete inspectable before it happens. `retention:run` refuses
  // outright while the feature is switched off, which is how it ships.
  ipcMain.handle('retention:preview', (event) => previewRetention(getDb(), requireSession(event)))
  ipcMain.handle('retention:setEnabled', (event, enabled: boolean) =>
    setRetention(getDb(), requireSession(event), enabled),
  )
  ipcMain.handle('retention:run', (event) => runRetention(getDb(), requireSession(event)))
  ipcMain.handle('retention:purgeLog', (event) => getPurgeHistory(getDb(), requireSession(event)))

  // Full sales-history export (PHASE12.md section 4) — Owner-only via the
  // existing `report:view_all`, so **no new Action and the harness stays at 48**.
  //
  // Unlike `reports:exportCsv` above, this **builds the document main-side**
  // rather than receiving finished text from the renderer. Phase 11's rule was
  // that a report's file must match the figures on screen, so it is assembled
  // from displayed state; here there is no displayed state — the export is
  // deliberately everything, including years never rendered on one screen — and
  // shipping every row to the renderer purely to have it sent back would serve
  // a rule that does not apply.
  ipcMain.handle('sales:exportHistory', async (event) => {
    const db = getDb()
    const user = requireSession(event)
    const { csv, saleCount, rowCount } = exportFullSalesHistory(db, user)

    const window = BrowserWindow.fromWebContents(event.sender)
    const defaultPath = `swastik-sales-history-${todayRange().from}.csv`
    const options = { defaultPath, filters: [{ name: 'CSV', extensions: ['csv'] }] }
    const result = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options))

    // A dismissed dialog is a choice, not a fault — reported the same way the
    // Phase 11 export and the print path report a cancelled dialog.
    if (result.canceled || !result.filePath) return { saved: false, filePath: null, saleCount, rowCount }

    fs.writeFileSync(result.filePath, csv, 'utf8')
    return { saved: true, filePath: result.filePath, saleCount, rowCount }
  })

  // WhatsApp Web session (PHASE6.md section 1). Both roles can read the
  // status snapshot — the badge in the app shell is visible to Owner and
  // Salesman alike, since every sale depends on this being live — but only
  // the Owner can actually connect/reconnect/log out, enforced the same way
  // as every other write channel: assertPermission on the caller's session
  // role, never a renderer-supplied argument.
  //
  // These now reach the session through the agent process rather than calling
  // whatsapp/client.ts directly, but the channel names, their arguments and
  // their permission checks are unchanged — preload.ts and every renderer
  // component are untouched by the split.
  ipcMain.handle('whatsapp:getState', (event) => {
    requireSession(event)
    // Read from the cache the event stream keeps current, not over the wire:
    // this feeds the status badge on every screen and must not be able to hang.
    return getAgentState()
  })
  ipcMain.handle('whatsapp:connect', (event) => {
    const user = requireSession(event)
    assertPermission(user.role, 'whatsapp:manage_session')
    return requestAgentConnect()
  })
  ipcMain.handle('whatsapp:logout', (event) => {
    const user = requireSession(event)
    assertPermission(user.role, 'whatsapp:manage_session')
    return requestAgentLogout()
  })
  // Owner-only: wipes the embedded WhatsApp Web view's own linked session
  // (cookies, local storage, service workers) so it can be re-linked from
  // scratch — the escape hatch for a view stuck on a stale or wrong login.
  // Deliberately independent of `whatsapp:logout`, which unlinks the billing
  // session; the two are separate linked devices and are unlinked separately.
  ipcMain.handle('whatsapp:resetWebView', async (event) => {
    const user = requireSession(event)
    assertPermission(user.role, 'whatsapp:manage_session')
    await session.fromPartition(WHATSAPP_WEB_PARTITION).clearStorageData()
  })
  // Owner-only bill-delivery view (Connect WhatsApp screen): every bill sent
  // to a customer, with real WhatsApp delivery/read ticks. Built entirely
  // from this app's own whatsapp_log/sales/parties tables (never WhatsApp's
  // actual chat list), so it can only ever show customers this shop sent a
  // bill to — nothing else the linked phone might have in its inbox.
  ipcMain.handle('whatsapp:billDeliveries', (event) => {
    const user = requireSession(event)
    assertPermission(user.role, 'whatsapp:view_deliveries')
    return getCustomerBillDeliveries(getDb())
  })
  // How many bills are still waiting to go out. Ungated beyond a live session,
  // like `whatsapp:getState`: this drives a count next to the status badge that
  // both roles see, and it is what now stands in for the print gate that used
  // to block — an undelivered bill has to stay visible to whoever is at the
  // counter, not only to the Owner.
  ipcMain.handle('whatsapp:pendingCount', (event) => {
    requireSession(event)
    return countSalesAwaitingWhatsApp(getDb())
  })
  // Owner-only retry for a bill that didn't go out — the counterpart to the
  // print override, and usually the better answer: the override unlocks the
  // printer while leaving the customer without their bill, this actually
  // sends it. `sendSaleWhatsAppNotifications` skips recipients already marked
  // sent, so a retry can't duplicate a copy that did land. Returns the
  // refreshed delivery list so the caller renders the outcome without a
  // second round trip.
  ipcMain.handle('whatsapp:resendBill', async (event, saleId: number) => {
    const db = getDb()
    const user = requireSession(event)
    assertPermission(user.role, 'whatsapp:resend_bill')
    const sale = getSaleById(db, saleId)
    if (!sale) throw new Error(`Sale ${saleId} no longer exists.`)
    const party = sale.party_id != null ? getPartyById(db, sale.party_id) : null
    await sendSaleWhatsAppNotifications(db, sale, party?.name ?? null, party?.phone ?? null)
    return getCustomerBillDeliveries(db)
  })
  // Forwarded to every renderer window (there's only ever one) so the status
  // badge and Connect screen update live without polling.
  const handleAgentState = (state: WhatsAppState): void => {
    console.log(`[whatsapp] status -> ${state.status}${state.lastError ? ` (${state.lastError})` : ''}`)
    mainWindow?.webContents.send('whatsapp:state', state)

    // The moment the session is back, push out anything that couldn't go while
    // it was down. This is what makes removing the blocking print gate safe:
    // print no longer waits for delivery, so the promise that the bill still
    // arrives rests on this. Only on the transition into `connected`, never on
    // a repeat of it, or a flapping session would restart the queue mid-run.
    if (state.status === 'connected' && lastAgentStatus !== 'connected') {
      void retryPendingBills(getDb())
        .then(() => mainWindow?.webContents.send('whatsapp:pendingChanged'))
        .catch((err: unknown) => console.error('[whatsapp] retrying queued bills failed:', err))
    }
    lastAgentStatus = state.status
  }
  onAgentStateChange(handleAgentState)

  /**
   * Replay the state the agent is already in, because subscribing late meant
   * missing it entirely.
   *
   * `connectToAgent()` runs several hundred lines above, and the agent answers
   * a new subscriber with its current state immediately (see
   * `handleEventStream` in agent/server.ts). So whenever the agent is already
   * connected — the *normal* case now that it outlives the billing window, and
   * the whole point of the process split — that first event arrives before
   * this listener exists and is dropped into an empty listener array. The
   * transition into `connected` then never fires for this app process, and the
   * queued-bill retry above never runs: bills sit unsent until the session
   * happens to drop and come back on its own. Found with nine bills stranded
   * that way since a session had gone down days earlier.
   *
   * `lastAgentStatus` makes this idempotent — if the event did land in time,
   * this second call is a no-op rather than a second pass over the queue.
   */
  handleAgentState(getAgentState())
  // Real WhatsApp delivery/read events, persisted against the log row that
  // sent them and pushed live to the renderer so the bill-delivery ticks
  // update without polling, the same pattern as whatsapp:state above. Matching
  // an ack to its log row stays here rather than in the agent, because this is
  // the process that owns the database.
  onAgentMessageAck((waMessageId, ack) => {
    const logId = updateWhatsAppAckByMessageId(getDb(), waMessageId, ack)
    if (logId !== null) mainWindow?.webContents.send('whatsapp:ack', { waMessageId, ack })
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * Starts the agent at login, so the session survives a reboot and not merely an
 * app restart — an overnight shutdown was otherwise still a guaranteed morning
 * resync. Points Windows at this same binary with the agent flag; the billing
 * window is never opened at login.
 *
 * Packaged builds only: in dev `process.execPath` is
 * `node_modules/electron/dist/electron.exe`, and registering a path inside a
 * checkout to run at every login is not something a dev machine should inherit
 * from running the app once.
 */
function registerAgentAutostart(): void {
  if (!app.isPackaged || process.platform !== 'win32') return
  try {
    app.setLoginItemSettings({ openAtLogin: true, args: [AGENT_ARGV_FLAG] })
  } catch (err: unknown) {
    // Best-effort: without it the agent still starts on the app's first launch
    // of the day, which is the old behaviour rather than a regression.
    console.warn('[whatsapp] could not register the agent to start at login:', err)
  }
}

/**
 * Set once the on-close backup has run, so the re-quit below cannot re-enter
 * this handler and start a second one.
 *
 * Quitting out from under a teardown is one of the documented ways this project
 * previously orphaned a Chrome process (see the Phase 6 notes in CLAUDE.md), so
 * the guard is deliberate rather than defensive habit.
 */
let quitHandled = false

// Closing the billing window no longer touches the WhatsApp session — it only
// drops this process's subscription to it. That is the entire point of the
// agent split: the previous version destroyed the session here, so every close
// was an offline period and every reopen paid for it with a full offline-
// message resync before a single bill could be sent.
//
// Since Phase 12 this also takes the on-close snapshot, when the schedule asks
// for one. `runOnCloseBackupIfDue` skips itself when Drive isn't connected, when
// the setting is off, or when a successful backup already landed in the last
// hour — so the ordinary evening close is instant — and is hard-bounded at 8s
// so a dead network can slow the app's exit but never trap it.
app.on('before-quit', (event) => {
  disconnectFromAgent()
  stopBackupScheduler()
  stopRetentionScheduler()

  if (quitHandled) return
  quitHandled = true

  event.preventDefault()
  void runOnCloseBackupIfDue(getDb()).finally(() => app.quit())
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
