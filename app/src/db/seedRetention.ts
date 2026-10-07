/**
 * Backdated test data for the retention/purge job (PHASE12.md section 3,
 * "Testing Requirement").
 *
 * Section 3 is explicit that an irreversible delete must not be developed
 * against real data, so this builds a database whose sales are artificially
 * dated 31, 40 and 91 days in the past, alongside `backup_log` rows arranged to
 * exercise **both** sides of the safeguard.
 *
 * Run with: npm run seed:retention -- <path-to-a-throwaway.db>
 *
 * **It refuses to write to the shop's real database.** That is an explicit
 * check below, not a convention to remember — the whole point of this file is
 * to make a destructive job testable without ever pointing it at the real
 * thing, and a seed script that a tired finger could aim at `app.db` would
 * undermine that completely.
 *
 * ## The timeline, which is the actual subject of the test
 *
 * The safeguard asks one question: **is there a `success` row in `backup_log`
 * dated after this sale was created?** So the fixture places exactly one
 * successful backup — 35 days ago — and arranges sales on both sides of it:
 *
 *     91d ago   40d ago      35d ago       31d ago    5d ago   1d ago  now
 *      sale      sale      ✅ BACKUP        sale       sale    ❌ failed
 *      └─ covered ─┘                         └── not covered ──┘
 *
 * A sale older than the backup is captured by it. A sale *newer* than it is
 * not — even though it is well past 30 days old, and even though two failed
 * backups have happened since. That is the case criterion 7 is about, and it is
 * the one a careless implementation gets wrong.
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RETENTION_TOTAL_DAYS } from '../lib/retention.js'
import { runMigrations } from './migrationRunner.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

/** The one successful backup in the fixture. Everything older than this is captured by it; everything newer is not. */
const BACKUP_DAYS_AGO = 35

/** Where the real database lives. Anything resolving here is refused outright. */
function realAppDbPaths(): string[] {
  const appData = process.env.APPDATA
  return [
    appData ? path.join(appData, 'Swastik Collection Billing', 'app.db') : null,
    path.join(os.homedir(), 'AppData', 'Roaming', 'Swastik Collection Billing', 'app.db'),
  ]
    .filter((value): value is string => value != null)
    .map((value) => path.resolve(value).toLowerCase())
}

export function assertSafeSeedTarget(target: string): void {
  const resolved = path.resolve(target).toLowerCase()
  if (realAppDbPaths().includes(resolved)) {
    throw new Error(
      `Refusing to seed ${target} — that is the shop's real database. ` +
        'This script only ever writes to a throwaway file (PHASE12.md section 3).',
    )
  }
  // Belt and braces: the real database is always called app.db, so that name is
  // refused wherever it appears. A test database should be named for what it is.
  if (path.basename(resolved) === 'app.db') {
    throw new Error(`Refusing to seed a file named app.db (${target}). Use a distinctly-named test database.`)
  }
}

export interface SeedCase {
  label: string
  daysAgo: number
  isCashBill: boolean
  grandTotal: number
  expectation: string
}

/** Every case PHASE12.md section 7's criteria 6-8 turn on, and nothing else. */
export const RETENTION_CASES: SeedCase[] = [
  {
    label: 'cash-91d-covered',
    daysAgo: 91,
    isCashBill: true,
    grandTotal: 700,
    expectation: 'PURGED locally — old, backed up, and past its purge_at (criterion 6)',
  },
  {
    label: 'cash-40d-covered',
    daysAgo: 40,
    isCashBill: true,
    grandTotal: 450,
    expectation: 'PURGED locally — past 30 days and captured by the backup (criterion 6)',
  },
  {
    label: 'cash-31d-uncovered',
    daysAgo: 31,
    isCashBill: true,
    grandTotal: 500,
    expectation: 'HELD BACK — past 30 days, but no *successful* backup ran after it (criterion 7)',
  },
  {
    label: 'credit-91d',
    daysAgo: 91,
    isCashBill: false,
    grandTotal: 800,
    expectation: 'UNTOUCHED — credit sales are exempt at any age (criterion 8)',
  },
  {
    label: 'credit-40d',
    daysAgo: 40,
    isCashBill: false,
    grandTotal: 850,
    expectation: 'UNTOUCHED — exempt even though it is old and backed up',
  },
  {
    label: 'cash-5d',
    daysAgo: 5,
    isCashBill: true,
    grandTotal: 900,
    expectation: 'UNTOUCHED — still inside the 30-day local window',
  },
]

/** A UTC 'YYYY-MM-DD HH:MM:SS' the given number of days ago — the exact shape `datetime('now')` writes. */
export function daysAgoUtc(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Builds the fixture. Exported so `retention.test.ts` drives the identical
 * scenario the manual script does — one description of the world rather than
 * two that could quietly disagree.
 *
 * Returns the sale id for each case label, so assertions can name the case they
 * are about instead of a bare number.
 */
export function seedRetentionFixtures(db: Database.Database): Record<string, number> {
  const ownerId = db
    .prepare("INSERT INTO users (username, password_hash, role, full_name) VALUES ('owner', 'x', 'owner', 'Shop Owner')")
    .run().lastInsertRowid as number
  const partyId = db
    .prepare('INSERT INTO parties (name, phone, balance, created_by_user_id) VALUES (?, ?, ?, ?)')
    .run('Retention Test Party', '9876500099', 0, ownerId).lastInsertRowid as number

  const insertSale = db.prepare(
    `INSERT INTO sales (party_id, salesman_user_id, payment_mode, cash_amount, upi_amount, credit_amount,
                        subtotal, total_discount, grand_total, is_cash_bill, purge_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertItem = db.prepare(
    'INSERT INTO sale_items (sale_id, item_name, barcode, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const insertWhatsAppLog = db.prepare(
    "INSERT INTO whatsapp_log (sale_id, recipient_type, recipient_number, status) VALUES (?, 'owner', '919999999999', 'sent')",
  )
  const insertBackup = db.prepare(
    'INSERT INTO backup_log (status, drive_file_id, triggered_by, file_name, created_at) VALUES (?, ?, ?, ?, ?)',
  )

  const ids: Record<string, number> = {}

  db.transaction(() => {
    for (const testCase of RETENTION_CASES) {
      const credit = testCase.isCashBill ? 0 : testCase.grandTotal
      const saleId = insertSale.run(
        partyId,
        ownerId,
        testCase.isCashBill ? 'cash' : 'credit',
        testCase.isCashBill ? testCase.grandTotal : 0,
        0,
        credit,
        testCase.grandTotal,
        0,
        testCase.grandTotal,
        testCase.isCashBill ? 1 : 0,
        // purge_at is created_at + RETENTION_TOTAL_DAYS, exactly as createSale computes it.
        daysAgoUtc(testCase.daysAgo - RETENTION_TOTAL_DAYS),
        daysAgoUtc(testCase.daysAgo),
      ).lastInsertRowid as number

      ids[testCase.label] = saleId
      insertItem.run(saleId, `Item for ${testCase.label}`, null, 1, testCase.grandTotal, testCase.grandTotal)
      // Every sale gets a whatsapp_log row on purpose: `whatsapp_log.sale_id`
      // has no ON DELETE CASCADE, so the local purge has to handle the foreign
      // key rather than only being exercised on bills that happen to have none.
      insertWhatsAppLog.run(saleId)

      if (!testCase.isCashBill) {
        db.prepare('UPDATE parties SET balance = balance + ? WHERE id = ?').run(credit, partyId)
      }
    }

    // The single successful backup the whole fixture pivots on.
    insertBackup.run('success', 'drive-covering-backup', 'scheduled', 'swastik-backup-covering.db', daysAgoUtc(BACKUP_DAYS_AGO))

    // Recent *failed* attempts. These postdate every sale, so an implementation
    // that forgot `status = 'success'` would suddenly consider everything
    // backed up and purge the lot — which is what these are here to catch.
    insertBackup.run('failed', null, 'scheduled', 'swastik-backup-failed.db', daysAgoUtc(1))
    insertBackup.run('failed', null, 'manual', 'swastik-backup-failed-2.db', daysAgoUtc(0))
  })()

  return ids
}

/**
 * The credit-bill half of the fixture (client decision, 2026-09-19: credit bills
 * are kept while owed and removed 60 days after the customer clears them).
 *
 * Separate from `seedRetentionFixtures` so the cash timeline above keeps meaning
 * exactly what it did. Call it *after* that function: it relies on the owner
 * user and on the single successful backup 35 days ago, and arranges each party's
 * last activity on one side of it —
 *
 *   settled-covered    last activity 45d ago  → PURGED (old enough, backed up after)
 *   settled-uncovered  last activity 32d ago  → HELD BACK (old enough, but the backup predates it)
 *   settled-recent     last activity 10d ago  → UNTOUCHED (settled, but inside the 30 days)
 *   reborrowed         paid off 45d ago, borrowed again 5d ago → UNTOUCHED (owes again)
 *   advance            overpaid, balance below zero → UNTOUCHED (its payments are the only record)
 *
 * Returns the party id and its credit-sale ids by label.
 */
export interface CreditFixture {
  partyId: number
  saleIds: number[]
}

export function seedCreditRetentionFixtures(db: Database.Database): Record<string, CreditFixture> {
  const ownerId = (db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as { id: number }).id

  const insertParty = db.prepare('INSERT INTO parties (name, phone, balance, created_by_user_id) VALUES (?, ?, ?, ?)')
  const insertCredit = db.prepare(
    `INSERT INTO sales (party_id, salesman_user_id, payment_mode, cash_amount, upi_amount, credit_amount,
                        subtotal, total_discount, grand_total, is_cash_bill, purge_at, created_at)
     VALUES (?, ?, 'credit', 0, 0, ?, ?, 0, ?, 0, ?, ?)`,
  )
  const insertItem = db.prepare(
    'INSERT INTO sale_items (sale_id, item_name, barcode, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const insertWhatsAppLog = db.prepare(
    "INSERT INTO whatsapp_log (sale_id, recipient_type, recipient_number, status) VALUES (?, 'owner', '919999999999', 'sent')",
  )
  const insertPayment = db.prepare(
    'INSERT INTO payments (party_id, amount, mode, recorded_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)',
  )

  const out: Record<string, CreditFixture> = {}

  function party(
    label: string,
    phone: string,
    events: Array<{ kind: 'credit' | 'payment'; daysAgo: number; amount: number }>,
  ): void {
    const partyId = insertParty.run(label, phone, 0, ownerId).lastInsertRowid as number
    const saleIds: number[] = []
    let balance = 0
    for (const event of events) {
      if (event.kind === 'credit') {
        const saleId = insertCredit.run(
          partyId,
          ownerId,
          event.amount,
          event.amount,
          event.amount,
          daysAgoUtc(event.daysAgo - RETENTION_TOTAL_DAYS),
          daysAgoUtc(event.daysAgo),
        ).lastInsertRowid as number
        insertItem.run(saleId, `Item for ${label}`, null, 1, event.amount, event.amount)
        insertWhatsAppLog.run(saleId)
        saleIds.push(saleId)
        balance += event.amount
      } else {
        insertPayment.run(partyId, event.amount, 'cash', ownerId, daysAgoUtc(event.daysAgo))
        balance -= event.amount
      }
    }
    db.prepare('UPDATE parties SET balance = ? WHERE id = ?').run(balance, partyId)
    out[label] = { partyId, saleIds }
  }

  db.transaction(() => {
    party('settled-covered', '9876500101', [
      { kind: 'credit', daysAgo: 50, amount: 500 },
      { kind: 'payment', daysAgo: 45, amount: 500 },
    ])
    party('settled-uncovered', '9876500102', [
      { kind: 'credit', daysAgo: 33, amount: 300 },
      { kind: 'payment', daysAgo: 32, amount: 300 },
    ])
    party('settled-recent', '9876500103', [
      { kind: 'credit', daysAgo: 20, amount: 200 },
      { kind: 'payment', daysAgo: 10, amount: 200 },
    ])
    party('reborrowed', '9876500104', [
      { kind: 'credit', daysAgo: 50, amount: 400 },
      { kind: 'payment', daysAgo: 45, amount: 400 },
      { kind: 'credit', daysAgo: 5, amount: 150 },
    ])
    party('advance', '9876500105', [
      { kind: 'credit', daysAgo: 50, amount: 100 },
      { kind: 'payment', daysAgo: 45, amount: 250 },
    ])
  })()

  return out
}

function main(): void {
  const target = process.argv[2]
  if (!target) {
    console.error('Usage: npm run seed:retention -- <path-to-a-throwaway.db>')
    process.exit(1)
  }

  assertSafeSeedTarget(target)
  fs.rmSync(target, { force: true })
  fs.rmSync(`${target}-wal`, { force: true })
  fs.rmSync(`${target}-shm`, { force: true })

  const db = new Database(target)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db, MIGRATIONS_DIR)

  const ids = seedRetentionFixtures(db)
  const credit = seedCreditRetentionFixtures(db)

  console.log(`\nSeeded retention fixtures into ${target}\n`)
  for (const testCase of RETENTION_CASES) {
    const kind = testCase.isCashBill ? 'cash  ' : 'credit'
    console.log(`  sale #${String(ids[testCase.label]).padEnd(3)} ${kind} ${String(testCase.daysAgo).padStart(3)}d ago  → ${testCase.expectation}`)
  }

  console.log('\ncredit parties (kept while owed, removed 60 days after they clear):')
  for (const [label, fixture] of Object.entries(credit)) {
    console.log(`  party #${String(fixture.partyId).padEnd(3)} ${label}`)
  }

  console.log('\nbackup_log:')
  for (const row of db.prepare('SELECT status, drive_file_id, created_at FROM backup_log ORDER BY id').all() as Array<{
    status: string
    drive_file_id: string | null
    created_at: string
  }>) {
    console.log(`  ${row.status.padEnd(8)} ${row.created_at}  ${row.drive_file_id ?? '(no file)'}`)
  }
  console.log()
  db.close()
}

// Only when run directly, so the exported builders can be imported by tests
// without the CLI firing.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
