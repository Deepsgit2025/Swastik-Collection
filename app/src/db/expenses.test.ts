// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getExpenseById, getExpenses, getExpensesTotal, logExpense } from './expenses.ts'
import { PermissionError, assertPermission } from './permissions.ts'
import type { SafeUser } from '../types/user.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let ownerId: number
let salesmanId: number
let owner: SafeUser
let salesman: SafeUser

beforeEach(() => {
  db = new Database(':memory:')
  for (const file of ['001_init.sql', '002_core_schema.sql', '008_expense_date.sql']) {
    db.exec(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf-8'))
  }

  ownerId = db
    .prepare(`INSERT INTO users (username, password_hash, role, full_name) VALUES ('owner', 'x', 'owner', 'Shop Owner')`)
    .run().lastInsertRowid as number
  salesmanId = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, full_name) VALUES ('salesman1', 'x', 'salesman', 'Test Salesman')`,
    )
    .run().lastInsertRowid as number

  owner = { id: ownerId, username: 'owner', role: 'owner', full_name: 'Shop Owner' }
  salesman = { id: salesmanId, username: 'salesman1', role: 'salesman', full_name: 'Test Salesman' }
})

describe('logExpense', () => {
  it('inserts the expense with the given category, amount, date and note', () => {
    const expense = logExpense(db, owner, {
      category: 'Rent',
      amount: 12000,
      date: '2026-08-01',
      note: 'August shop rent',
    })

    expect(expense).toMatchObject({
      category: 'Rent',
      amount: 12000,
      expense_date: '2026-08-01',
      note: 'August shop rent',
      logged_by_user_id: ownerId,
    })
  })

  it('stores an omitted or blank note as NULL rather than an empty string', () => {
    const noNote = logExpense(db, owner, { category: 'Staff', amount: 500, date: '2026-08-10' })
    const blankNote = logExpense(db, owner, {
      category: 'Staff',
      amount: 500,
      date: '2026-08-10',
      note: '   ',
    })

    expect(noNote.note).toBeNull()
    expect(blankNote.note).toBeNull()
  })

  it('attributes the expense to the passed-in user, not to anything in the input', () => {
    const expense = logExpense(db, salesman, { category: 'Transport', amount: 80, date: '2026-08-12' })

    expect(expense.logged_by_user_id).toBe(salesmanId)
  })

  it('rounds a fractional amount to paise rather than storing float drift', () => {
    const expense = logExpense(db, owner, { category: 'Supplies', amount: 0.1 + 0.2, date: '2026-08-12' })

    expect(expense.amount).toBe(0.3)
  })
})

/**
 * PHASE9.md section 0 / acceptance criterion 1 — the confirmed decision that a
 * Salesman logs expenses, reversing the earlier Owner-only assumption. These
 * are the tests that would catch `expense:create` being narrowed back.
 */
describe('logExpense permissions', () => {
  it('allows a Salesman to log an expense', () => {
    const expense = logExpense(db, salesman, { category: 'Electricity', amount: 2400, date: '2026-08-05' })

    expect(expense.logged_by_user_id).toBe(salesmanId)
    expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 1 })
  })

  it('allows an Owner to log an expense', () => {
    const expense = logExpense(db, owner, { category: 'Electricity', amount: 2400, date: '2026-08-05' })

    expect(expense.logged_by_user_id).toBe(ownerId)
  })

  it('does not throw PermissionError for a Salesman — expense:create stays allowed for both roles', () => {
    // Guards the section 3 table from drifting back to Owner-only.
    expect(() =>
      logExpense(db, salesman, { category: 'Other', amount: 10, date: '2026-08-05' }),
    ).not.toThrow(PermissionError)
  })

  /**
   * PHASE9.md acceptance criterion 3 — the backend rule must hold on its own,
   * even though this phase builds no UI that reaches an edit or delete. There
   * is no `updateExpense`/`deleteExpense` function to call, so what is
   * asserted here is the layer any such function would have to go through
   * first: a direct `assertPermission` call as a Salesman is rejected.
   */
  it('rejects a Salesman for expense:edit and expense:delete at the permission layer', () => {
    expect(() => assertPermission(salesman.role, 'expense:edit')).toThrow(PermissionError)
    expect(() => assertPermission(salesman.role, 'expense:delete')).toThrow(PermissionError)

    expect(() => assertPermission(owner.role, 'expense:edit')).not.toThrow()
    expect(() => assertPermission(owner.role, 'expense:delete')).not.toThrow()
  })
})

/**
 * The same pure validators the screen runs inline (src/lib/expenseMath.ts),
 * but these are the calls that actually gate the write — a modified renderer
 * skipping its own check still cannot get past them.
 */
describe('logExpense validation', () => {
  it.each([0, -50])('rejects an amount of %s without inserting', (amount) => {
    expect(() => logExpense(db, owner, { category: 'Rent', amount, date: '2026-08-01' })).toThrow(
      /greater than 0/i,
    )

    expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 0 })
  })

  it('rejects a category outside the fixed set, without inserting', () => {
    expect(() =>
      logExpense(db, owner, {
        category: 'Bribes' as unknown as 'Rent',
        amount: 100,
        date: '2026-08-01',
      }),
    ).toThrow(/Choose a category/i)

    expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 0 })
  })

  it.each(['', '01-08-2026', '2026-8-1'])(
    'rejects a malformed date %s without inserting',
    (date) => {
      expect(() => logExpense(db, owner, { category: 'Rent', amount: 100, date })).toThrow(
        /expense date/i,
      )

      expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 0 })
    },
  )

  it('rejects a well-formed but non-existent day rather than rolling it forward', () => {
    // `new Date('2026-02-30')` silently becomes March 2nd — this is the case
    // that catches, which a bare format check would let through.
    expect(() => logExpense(db, owner, { category: 'Rent', amount: 100, date: '2026-02-30' })).toThrow(
      /not a real date/i,
    )
  })
})

/** PHASE9.md section 1 / acceptance criteria 1 and 4. */
describe('getExpenses', () => {
  beforeEach(() => {
    logExpense(db, owner, { category: 'Rent', amount: 12000, date: '2026-08-01', note: 'August rent' })
    logExpense(db, salesman, { category: 'Transport', amount: 150, date: '2026-08-10' })
    logExpense(db, salesman, { category: 'Supplies', amount: 300, date: '2026-08-20' })
    logExpense(db, owner, { category: 'Electricity', amount: 2400, date: '2026-09-02' })
  })

  it('returns every expense, newest first, regardless of who logged it', () => {
    const rows = getExpenses(db)

    expect(rows.map((row) => row.expense_date)).toEqual([
      '2026-09-02',
      '2026-08-20',
      '2026-08-10',
      '2026-08-01',
    ])
  })

  it('joins the logging user name onto each row', () => {
    const rows = getExpenses(db)

    expect(rows.find((row) => row.category === 'Rent')!.logged_by_name).toBe('Shop Owner')
    expect(rows.find((row) => row.category === 'Transport')!.logged_by_name).toBe('Test Salesman')
  })

  it('narrows to an inclusive date range', () => {
    const rows = getExpenses(db, { from: '2026-08-01', to: '2026-08-20' })

    // Both boundary days are included, and September is excluded.
    expect(rows.map((row) => row.category)).toEqual(['Supplies', 'Transport', 'Rent'])
  })

  it('treats a single day as a range of that day alone', () => {
    const rows = getExpenses(db, { from: '2026-08-10', to: '2026-08-10' })

    expect(rows.map((row) => row.category)).toEqual(['Transport'])
  })

  it('accepts either end of the range on its own', () => {
    expect(getExpenses(db, { from: '2026-08-20' }).map((row) => row.category)).toEqual([
      'Electricity',
      'Supplies',
    ])
    expect(getExpenses(db, { to: '2026-08-10' }).map((row) => row.category)).toEqual([
      'Transport',
      'Rent',
    ])
  })

  it('ignores blank or null range ends rather than filtering on them', () => {
    expect(getExpenses(db, { from: '', to: null })).toHaveLength(4)
  })

  it('returns an empty list for a range with nothing in it', () => {
    expect(getExpenses(db, { from: '2026-07-01', to: '2026-07-31' })).toEqual([])
  })

  it('orders same-day expenses by newest entry first', () => {
    const first = logExpense(db, owner, { category: 'Other', amount: 10, date: '2026-10-01' })
    const second = logExpense(db, owner, { category: 'Other', amount: 20, date: '2026-10-01' })

    const sameDay = getExpenses(db, { from: '2026-10-01', to: '2026-10-01' })
    expect(sameDay.map((row) => row.id)).toEqual([second.id, first.id])
  })
})

/**
 * PHASE9.md section 4 / acceptance criterion 5 — the sum Phase 10's dashboard
 * consumes directly. PHASE10.md's own criterion 1 is that the dashboard
 * figure matches a manual SQL sum of the day's `expenses`, so these check
 * against exactly that: an independently computed sum, not a hardcoded number.
 */
describe('getExpensesTotal', () => {
  beforeEach(() => {
    logExpense(db, owner, { category: 'Rent', amount: 12000, date: '2026-08-01' })
    logExpense(db, salesman, { category: 'Transport', amount: 150, date: '2026-08-10' })
    logExpense(db, salesman, { category: 'Supplies', amount: 300, date: '2026-08-20' })
    logExpense(db, owner, { category: 'Electricity', amount: 2400, date: '2026-09-02' })
  })

  it('sums every expense when no range is given', () => {
    expect(getExpensesTotal(db)).toBe(12000 + 150 + 300 + 2400)
  })

  it('sums only the expenses inside an inclusive range', () => {
    // Both boundary days counted, September excluded.
    expect(getExpensesTotal(db, { from: '2026-08-01', to: '2026-08-20' })).toBe(12000 + 150 + 300)
  })

  it('treats a single day as a range of that day alone — the shape Phase 10 asks for "today"', () => {
    expect(getExpensesTotal(db, { from: '2026-08-10', to: '2026-08-10' })).toBe(150)
  })

  it('accepts either end of the range on its own', () => {
    expect(getExpensesTotal(db, { from: '2026-08-20' })).toBe(300 + 2400)
    expect(getExpensesTotal(db, { to: '2026-08-10' })).toBe(12000 + 150)
  })

  it('returns 0 rather than null for a range with nothing in it', () => {
    // SUM over no rows is NULL in SQLite; an empty day has to read as a real
    // zero or Phase 10's dashboard renders a blank instead of ₹0.
    expect(getExpensesTotal(db, { from: '2026-07-01', to: '2026-07-31' })).toBe(0)
  })

  it('returns 0 on an empty table', () => {
    const empty = new Database(':memory:')
    for (const file of ['001_init.sql', '002_core_schema.sql', '008_expense_date.sql']) {
      empty.exec(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf-8'))
    }

    expect(getExpensesTotal(empty)).toBe(0)
    empty.close()
  })

  it('counts expenses from both roles, not just the rows the caller logged', () => {
    // Shop-wide financial visibility, same as the list (criterion 1) — a
    // total that silently dropped the Salesman's rows would understate the
    // Owner's dashboard.
    expect(getExpensesTotal(db, { from: '2026-08-10', to: '2026-08-20' })).toBe(150 + 300)
  })

  it('does not accumulate float drift across many REAL amounts', () => {
    const drifty = new Database(':memory:')
    for (const file of ['001_init.sql', '002_core_schema.sql', '008_expense_date.sql']) {
      drifty.exec(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf-8'))
    }
    drifty
      .prepare(`INSERT INTO users (username, password_hash, role, full_name) VALUES ('owner', 'x', 'owner', 'Shop Owner')`)
      .run()
    const driftyOwner: SafeUser = { id: 1, username: 'owner', role: 'owner', full_name: 'Shop Owner' }
    for (let i = 0; i < 10; i += 1) {
      logExpense(drifty, driftyOwner, { category: 'Other', amount: 0.1, date: '2026-08-01' })
    }

    // Ten 0.10 rows sum to 0.9999999999999999 as raw REALs.
    expect(getExpensesTotal(drifty)).toBe(1)
    drifty.close()
  })

  /**
   * The total and the list share one range-clause builder, so this is the
   * test that would catch them drifting apart — an off-by-one on either end
   * would show up as a total that disagrees with the rows displayed under it.
   */
  it.each([
    {},
    { from: '2026-08-01', to: '2026-08-20' },
    { from: '2026-08-10', to: '2026-08-10' },
    { from: '2026-08-20' },
    { to: '2026-08-10' },
    { from: '', to: null },
    { from: '2026-07-01', to: '2026-07-31' },
  ])('agrees with the sum of the rows getExpenses returns for the same range (%o)', (range) => {
    const listed = getExpenses(db, range).reduce((sum, row) => sum + row.amount, 0)

    expect(getExpensesTotal(db, range)).toBe(Math.round(listed * 100) / 100)
  })
})

describe('getExpenseById', () => {
  it('returns null for an id that does not exist', () => {
    expect(getExpenseById(db, 12345)).toBeNull()
  })
})

/**
 * Migration 008 adds `expense_date` to a table that already existed in 002, so
 * a shop upgrading mid-life gets the column added and backfilled rather than a
 * NULL date on every historical row.
 */
describe('008_expense_date migration', () => {
  it('backfills an existing row from its created_at date', () => {
    const fresh = new Database(':memory:')
    for (const file of ['001_init.sql', '002_core_schema.sql']) {
      fresh.exec(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf-8'))
    }
    fresh
      .prepare(`INSERT INTO users (username, password_hash, role, full_name) VALUES ('owner', 'x', 'owner', 'Shop Owner')`)
      .run()
    // A row written before the column existed.
    fresh
      .prepare(
        `INSERT INTO expenses (category, amount, note, logged_by_user_id, created_at)
         VALUES ('Rent', 5000, NULL, 1, '2026-07-15 09:30:00')`,
      )
      .run()

    fresh.exec(fs.readFileSync(path.join(__dirname, 'migrations', '008_expense_date.sql'), 'utf-8'))

    expect(getExpenses(fresh)[0]).toMatchObject({ category: 'Rent', expense_date: '2026-07-15' })
    fresh.close()
  })
})
