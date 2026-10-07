// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './migrationRunner.ts'
import { COUNTER_USERNAME, ensureCounterUser } from './seed.ts'
import { getSalesmanBreakdown } from './reports.ts'
import { listSalesmen } from './salesmen.ts'
import type { SafeUser } from '../types/user.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

const owner: SafeUser = { id: 1, username: 'owner', role: 'owner', full_name: 'Shop Owner' }

/**
 * Migration 012 runs against a shop that has been trading for months, and it
 * rewrites how every one of those bills is attributed. The risk is not that it
 * crashes — it is that it succeeds and quietly detaches history from the people
 * who made it, which would look like an ordinary empty report.
 *
 * So these tests build a database at the *pre-012* schema, put real sales in
 * it, and then migrate — rather than starting from the finished schema, which
 * would prove nothing about the upgrade path the client's machine will take.
 */
function migrateThrough(db: Database.Database, lastFile: string): void {
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'))
    if (file === lastFile) return
  }
}

function applyMigration(file: string): void {
  db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'))
}

let db: Database.Database
let ownerId: number
let anilUserId: number
let bhavnaUserId: number

beforeEach(() => {
  db = new Database(':memory:')
  migrateThrough(db, '011_purge_log.sql')

  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, role, full_name, is_active) VALUES (?, ?, ?, ?, 1)',
  )
  ownerId = insertUser.run('owner', 'x', 'owner', 'Shop Owner').lastInsertRowid as number
  anilUserId = insertUser.run('salesman1', 'x', 'salesman', 'Anil Salesman').lastInsertRowid as number
  bhavnaUserId = insertUser.run('salesman2', 'x', 'salesman', 'Bhavna Salesman').lastInsertRowid as number
})

/** A sale written the pre-012 way — attribution living in `salesman_user_id` and nowhere else. */
function legacySale(userId: number, total: number): number {
  return db
    .prepare(
      `INSERT INTO sales (party_id, salesman_user_id, payment_mode, cash_amount, upi_amount, credit_amount,
                          subtotal, total_discount, grand_total, is_cash_bill)
       VALUES (NULL, ?, 'cash', ?, 0, 0, ?, 0, ?, 1)`,
    )
    .run(userId, total, total, total).lastInsertRowid as number
}

/** Just 012, on top of the pre-012 database the fixture built and filled. */
function applyLatest(): void {
  applyMigration('012_salesmen.sql')
}

describe('migration 012 — attribution moves off logins', () => {
  it('creates a salesman record for everyone who has ever made a sale, and links their bills', () => {
    legacySale(anilUserId, 500)
    legacySale(anilUserId, 300)
    legacySale(bhavnaUserId, 700)

    applyLatest()

    expect(listSalesmen(db).map((row) => row.name).sort()).toEqual(['Anil Salesman', 'Bhavna Salesman'])

    const unlinked = db.prepare('SELECT COUNT(*) AS count FROM sales WHERE salesman_id IS NULL').get() as {
      count: number
    }
    expect(unlinked.count).toBe(0)
  })

  /**
   * The figure that matters. Whatever else the migration does, the Owner must
   * open Reports the morning after the upgrade and see the same per-person
   * totals they saw the night before.
   */
  it('leaves every per-person total reading exactly as it did before', () => {
    legacySale(anilUserId, 500)
    legacySale(anilUserId, 300)
    legacySale(bhavnaUserId, 700)

    applyLatest()

    const rows = getSalesmanBreakdown(db, owner, {})
    expect(rows).toEqual([
      expect.objectContaining({ salesmanName: 'Anil Salesman', saleCount: 2, total: 800 }),
      expect.objectContaining({ salesmanName: 'Bhavna Salesman', saleCount: 1, total: 700 }),
    ])
  })

  /** An Owner who rings up bills is a salesman for reporting purposes, and their history must survive the move like anyone else's. */
  it("carries the Owner's own sales across too", () => {
    legacySale(ownerId, 900)

    applyLatest()

    expect(getSalesmanBreakdown(db, owner, {})).toEqual([
      expect.objectContaining({ salesmanName: 'Shop Owner', total: 900 }),
    ])
  })

  it('creates no salesman for a user who never sold anything', () => {
    legacySale(anilUserId, 500)

    applyLatest()

    expect(listSalesmen(db).map((row) => row.name)).toEqual(['Anil Salesman'])
  })

  /**
   * The logins stop working; the rows stay. `sales.salesman_user_id`,
   * `payments.recorded_by_user_id`, `expenses.logged_by_user_id`,
   * `parties.created_by_user_id` and the print-override log all reference them,
   * so deleting would break or orphan every record those people ever touched.
   */
  it('deactivates every salesman login without deleting a single row', () => {
    legacySale(anilUserId, 500)

    applyLatest()

    const rows = db
      .prepare("SELECT username, is_active FROM users WHERE role = 'salesman' ORDER BY username")
      .all() as { username: string; is_active: number }[]
    expect(rows).toEqual([
      { username: 'salesman1', is_active: 0 },
      { username: 'salesman2', is_active: 0 },
    ])
  })

  it('leaves the Owner login alone', () => {
    applyLatest()

    const row = db.prepare("SELECT is_active FROM users WHERE role = 'owner'").get() as { is_active: number }
    expect(row.is_active).toBe(1)
  })

  /**
   * The real upgrade path, not `applyLatest()`: a machine that has been running
   * since Phase 12 has `_migrations` rows for 001-011, and the next launch calls
   * `runMigrations`. Then the launch after that calls it again — the backfill
   * inserts rows, so running it twice would give the shop two "Anil Salesman"
   * records and split his sales across them.
   */
  it('backfills exactly once across repeated launches', () => {
    legacySale(anilUserId, 500)

    // What the runner would have written on the way to the 011 schema the
    // fixture built by hand.
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    const record = db.prepare('INSERT INTO _migrations (filename) VALUES (?)')
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (file === '012_salesmen.sql') break
      record.run(file)
    }

    runMigrations(db, MIGRATIONS_DIR)
    runMigrations(db, MIGRATIONS_DIR)

    expect(listSalesmen(db)).toHaveLength(1)
    expect(getSalesmanBreakdown(db, owner, {})).toEqual([
      expect.objectContaining({ salesmanName: 'Anil Salesman', saleCount: 1, total: 500 }),
    ])
  })
})

/**
 * Ordering, which is easy to get wrong and catastrophic when it is: the counter
 * account is created by `ensureCounterUser` *after* seeding, never by a
 * migration. A migration that inserted a user would leave `users` non-empty on
 * a fresh install, `seedDevUsers`' `COUNT(*) > 0` guard would skip creating the
 * Owner, and the app would ship with no password that unlocks anything.
 */
describe('the counter account against migration 012', () => {
  it('ends up active even though 012 deactivates every salesman-role row', () => {
    // The order a real upgrade takes: the account exists from a previous
    // launch, then 012 runs and sweeps every `role = 'salesman'` row.
    db.prepare("INSERT INTO users (username, password_hash, role, full_name) VALUES (?, '!', 'salesman', 'Counter')").run(
      COUNTER_USERNAME,
    )
    applyLatest()

    const swept = db.prepare('SELECT is_active FROM users WHERE username = ?').get(COUNTER_USERNAME) as {
      is_active: number
    }
    expect(swept.is_active).toBe(0)

    // Which is why `getDb()` calls this on every launch, after the migrations.
    ensureCounterUser(db)

    const restored = db.prepare('SELECT is_active FROM users WHERE username = ?').get(COUNTER_USERNAME) as {
      is_active: number
    }
    expect(restored.is_active).toBe(1)
  })
})
