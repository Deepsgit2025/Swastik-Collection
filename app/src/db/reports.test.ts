// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getDailySalesReport,
  getOutstandingCreditTotal,
  getOwnerDashboard,
  getPartyOutstandingList,
  getPartyOutstandingReport,
  getSalesLedger,
  getSalesmanBreakdown,
  getSalesmanReport,
  getSalesmanSales,
  getTodaysSalesSummary,
} from './reports.ts'
import { createSale as insertSale } from './sales.ts'
import { recordPayment } from './payments.ts'
import { getExpensesTotal, logExpense } from './expenses.ts'
import { PermissionError, assertPermission } from './permissions.ts'
import { todayIsoDate, todayRange } from '../lib/dateRange.ts'
import type { SafeUser } from '../types/user.ts'
import type { CreateSaleInput } from '../types/sale.ts'
import type { DateRange } from '../types/report.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
/** `users` ids — who was at the terminal. Since 2026-08-27 that is a session, not an attribution. */
let ownerId: number
let salesmanUserId: number
let otherSalesmanUserId: number
/** `salesmen` ids — who gets the credit. These are what the reports group by now. */
let ownerSalesmanId: number
let salesmanId: number
let otherSalesmanId: number
let partyId: number
let owner: SafeUser
let salesman: SafeUser
let otherSalesman: SafeUser

beforeEach(() => {
  db = new Database(':memory:')
  // Every migration, in order, rather than the subset this file used to name.
  // The composers reach further than the reporting tables do — `purge_log`
  // decides whether the retention note is shown — and a hand-picked list means
  // this suite breaks whenever a query grows a dependency it does not know
  // about, which is a maintenance cost with no matching benefit.
  const migrationsDir = path.join(__dirname, 'migrations')
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'))
  }

  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, role, full_name) VALUES (?, 'x', ?, ?)`,
  )
  ownerId = insertUser.run('owner', 'owner', 'Shop Owner').lastInsertRowid as number
  salesmanUserId = insertUser.run('salesman1', 'salesman', 'Anil Salesman').lastInsertRowid as number
  otherSalesmanUserId = insertUser.run('salesman2', 'salesman', 'Bhavna Salesman')
    .lastInsertRowid as number

  owner = { id: ownerId, username: 'owner', role: 'owner', full_name: 'Shop Owner' }
  // Role `salesman` because that is what the counter session is — these stand
  // for "somebody at the till", not for a login, which no longer exists.
  salesman = { id: salesmanUserId, username: 'salesman1', role: 'salesman', full_name: 'Anil Salesman' }
  otherSalesman = {
    id: otherSalesmanUserId,
    username: 'salesman2',
    role: 'salesman',
    full_name: 'Bhavna Salesman',
  }

  // The `salesmen` rows attribution actually runs through now. One per fixture
  // user, so `salesmanRowFor` below can keep every existing assertion about
  // "Anil's total" meaning exactly what it meant when attribution came from the
  // login.
  const insertSalesman = db.prepare('INSERT INTO salesmen (name) VALUES (?)')
  ownerSalesmanId = insertSalesman.run('Shop Owner').lastInsertRowid as number
  salesmanId = insertSalesman.run('Anil Salesman').lastInsertRowid as number
  otherSalesmanId = insertSalesman.run('Bhavna Salesman').lastInsertRowid as number

  partyId = db
    .prepare(
      `INSERT INTO parties (name, phone, balance, created_by_user_id) VALUES ('Ramesh Textiles', '9876500001', 0, ?)`,
    )
    .run(ownerId).lastInsertRowid as number
})

/**
 * A SQLite `datetime('now')`-shaped stamp (UTC, space-separated) for a given
 * **local** wall-clock moment — exactly what the DB would hold for something
 * that happened at that time in the shop.
 *
 * Written this way so these tests assert the same thing on any machine: on an
 * IST box `localMoment(2026, 8, 24, 0, 30)` produces '2026-08-23 19:00:00',
 * which is precisely the row that a naive `date(created_at)` would file under
 * the wrong day.
 */
function localMoment(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Which `salesmen` row stands for which fixture user.
 *
 * Attribution and session were the same thing until 2026-08-27 — a sale was
 * credited to whoever was logged in. They are separate now, and this mapping is
 * what lets these fixtures keep saying `createSale(db, salesman, ...)` and keep
 * meaning "a sale Anil made", rather than rewriting every call site to thread
 * an id that is only interesting in the handful of tests that assert on it.
 */
function salesmanRowFor(userId: number): number | null {
  if (userId === ownerId) return ownerSalesmanId
  if (userId === salesmanUserId) return salesmanId
  if (userId === otherSalesmanUserId) return otherSalesmanId
  return null
}

/**
 * A sale as the app writes one now: recorded by a session, credited to a
 * `salesmen` row. Shadows the imported `insertSale` so the call sites below
 * read the same as they always did.
 */
function createSale(
  database: Database.Database,
  user: SafeUser,
  input: CreateSaleInput,
): ReturnType<typeof insertSale> {
  return insertSale(database, user, {
    salesmanId: salesmanRowFor(user.id),
    ...input,
  })
}

function setSaleTime(saleId: number, stamp: string): void {
  db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(stamp, saleId)
}

function setPaymentTime(paymentId: number, stamp: string): void {
  db.prepare('UPDATE payments SET created_at = ? WHERE id = ?').run(stamp, paymentId)
}

function saleInput(overrides: Partial<CreateSaleInput> = {}): CreateSaleInput {
  return {
    partyId: null,
    items: [{ itemName: 'Cotton Saree', quantity: 1, unitPrice: 500 }],
    discount: 0,
    paymentMode: 'cash',
    cashAmount: 500,
    upiAmount: 0,
    creditAmount: 0,
    ...overrides,
  }
}

const AUG_24: DateRange = { from: '2026-08-24', to: '2026-08-24' }

describe('getTodaysSalesSummary — totals and the cash/UPI split', () => {
  it('returns all zeros for a range with nothing in it', () => {
    expect(getTodaysSalesSummary(db, owner, AUG_24)).toEqual({
      saleCount: 0,
      salesTotal: 0,
      cashFromSales: 0,
      upiFromSales: 0,
      creditIssued: 0,
      cashFromPayments: 0,
      upiFromPayments: 0,
      creditCollected: 0,
      cashCollected: 0,
      upiCollected: 0,
      totalCollected: 0,
    })
  })

  it('sums grand totals and splits cash, UPI and credit across a mixed day', () => {
    const cash = createSale(db, salesman, saleInput({ paymentMode: 'cash', cashAmount: 500 }))
    const upi = createSale(
      db,
      salesman,
      saleInput({
        items: [{ itemName: 'Kurta', quantity: 2, unitPrice: 400 }],
        paymentMode: 'upi',
        cashAmount: 0,
        upiAmount: 800,
      }),
    )
    const split = createSale(
      db,
      owner,
      saleInput({
        partyId,
        items: [{ itemName: 'Bedsheet', quantity: 1, unitPrice: 1000 }],
        paymentMode: 'split',
        cashAmount: 300,
        upiAmount: 200,
        creditAmount: 500,
      }),
    )
    for (const sale of [cash, upi, split]) setSaleTime(sale.id, localMoment(2026, 8, 24, 11))

    const summary = getTodaysSalesSummary(db, owner, AUG_24)

    expect(summary.saleCount).toBe(3)
    expect(summary.salesTotal).toBe(2300)
    expect(summary.cashFromSales).toBe(800)
    expect(summary.upiFromSales).toBe(1000)
    expect(summary.creditIssued).toBe(500)
    // Nothing was collected against an older bill, so the split is the sales' own.
    expect(summary.cashCollected).toBe(800)
    expect(summary.upiCollected).toBe(1000)
    expect(summary.totalCollected).toBe(1800)
  })

  it('counts a bill-level discount once — the total is what was billed, not the subtotal', () => {
    const sale = createSale(
      db,
      salesman,
      saleInput({
        items: [{ itemName: 'Saree', quantity: 1, unitPrice: 1000 }],
        discount: 150,
        cashAmount: 850,
      }),
    )
    setSaleTime(sale.id, localMoment(2026, 8, 24, 11))

    const summary = getTodaysSalesSummary(db, owner, AUG_24)

    expect(summary.salesTotal).toBe(850)
    expect(summary.cashCollected).toBe(850)
  })
})

/**
 * PHASE10.md acceptance criterion 4, and the specific rule section 1 spells
 * out: a credit sale's `credit_amount` is not cash/UPI collected on the day of
 * the sale — it becomes collected money only on the day a Payment-In against
 * it is recorded, and it is counted exactly once, then.
 */
describe('getTodaysSalesSummary — credit is not collected until it is paid', () => {
  const AUG_25: DateRange = { from: '2026-08-25', to: '2026-08-25' }
  const BOTH_DAYS: DateRange = { from: '2026-08-24', to: '2026-08-25' }

  beforeEach(() => {
    const creditSale = createSale(
      db,
      salesman,
      saleInput({
        partyId,
        items: [{ itemName: 'Silk Saree', quantity: 1, unitPrice: 1000 }],
        paymentMode: 'credit',
        cashAmount: 0,
        upiAmount: 0,
        creditAmount: 1000,
      }),
    )
    setSaleTime(creditSale.id, localMoment(2026, 8, 24, 11))

    const { payment } = recordPayment(db, salesman, { partyId, amount: 1000, mode: 'cash' })
    setPaymentTime(payment.id, localMoment(2026, 8, 25, 11))
  })

  it('shows the credit sale as issued, with nothing collected, on the day of the sale', () => {
    const day = getTodaysSalesSummary(db, owner, AUG_24)

    expect(day.salesTotal).toBe(1000)
    expect(day.creditIssued).toBe(1000)
    expect(day.cashCollected).toBe(0)
    expect(day.upiCollected).toBe(0)
    expect(day.totalCollected).toBe(0)
    expect(day.creditCollected).toBe(0)
  })

  it('counts the money on the day the Payment-In is recorded, with no sale that day', () => {
    const day = getTodaysSalesSummary(db, owner, AUG_25)

    expect(day.saleCount).toBe(0)
    expect(day.salesTotal).toBe(0)
    expect(day.creditIssued).toBe(0)
    expect(day.cashFromSales).toBe(0)
    expect(day.cashFromPayments).toBe(1000)
    expect(day.cashCollected).toBe(1000)
    expect(day.creditCollected).toBe(1000)
    expect(day.totalCollected).toBe(1000)
  })

  it('does not double-count the same rupee when the range spans both days', () => {
    const span = getTodaysSalesSummary(db, owner, BOTH_DAYS)
    const day1 = getTodaysSalesSummary(db, owner, AUG_24)
    const day2 = getTodaysSalesSummary(db, owner, AUG_25)

    // ₹1000 was billed once and collected once, even though both events fall
    // inside the range.
    expect(span.salesTotal).toBe(1000)
    expect(span.creditIssued).toBe(1000)
    expect(span.totalCollected).toBe(1000)
    // And the range is exactly the sum of its days — no overlap, no gap.
    expect(span.totalCollected).toBe(day1.totalCollected + day2.totalCollected)
    expect(span.salesTotal).toBe(day1.salesTotal + day2.salesTotal)
  })

  it('counts both when a credit sale is paid off the same day, without inflating the sale total', () => {
    const sale = createSale(
      db,
      salesman,
      saleInput({
        partyId,
        items: [{ itemName: 'Dupatta', quantity: 1, unitPrice: 600 }],
        paymentMode: 'credit',
        cashAmount: 0,
        upiAmount: 0,
        creditAmount: 600,
      }),
    )
    setSaleTime(sale.id, localMoment(2026, 8, 26, 10))
    const { payment } = recordPayment(db, salesman, { partyId, amount: 600, mode: 'upi' })
    setPaymentTime(payment.id, localMoment(2026, 8, 26, 18))

    const day = getTodaysSalesSummary(db, owner, { from: '2026-08-26', to: '2026-08-26' })

    expect(day.salesTotal).toBe(600)
    expect(day.creditIssued).toBe(600)
    expect(day.upiFromSales).toBe(0)
    expect(day.upiFromPayments).toBe(600)
    expect(day.upiCollected).toBe(600)
    expect(day.totalCollected).toBe(600)
  })

  it('counts a part payment against an older bill as collected, leaving the rest outstanding', () => {
    const { payment } = recordPayment(db, owner, { partyId, amount: 250, mode: 'cash' })
    setPaymentTime(payment.id, localMoment(2026, 8, 27, 11))

    const day = getTodaysSalesSummary(db, owner, { from: '2026-08-27', to: '2026-08-27' })

    expect(day.cashCollected).toBe(250)
    expect(day.creditCollected).toBe(250)
    // The party overpaid the ₹1000 bill by ₹250 across the two payments, so the
    // shop is owed nothing — a negative balance, not a negative credit total.
    expect(getOutstandingCreditTotal(db, owner)).toBe(0)
  })
})

describe('getTodaysSalesSummary — date range boundaries', () => {
  it('is inclusive at both ends and excludes days outside the range', () => {
    for (const [day, price] of [
      [23, 100],
      [24, 200],
      [25, 400],
      [26, 800],
    ] as const) {
      const sale = createSale(
        db,
        salesman,
        saleInput({ items: [{ itemName: 'Towel', quantity: 1, unitPrice: price }], cashAmount: price }),
      )
      setSaleTime(sale.id, localMoment(2026, 8, day, 11))
    }

    const summary = getTodaysSalesSummary(db, owner, { from: '2026-08-24', to: '2026-08-25' })

    expect(summary.salesTotal).toBe(600)
    expect(summary.saleCount).toBe(2)
  })

  it('treats an omitted end as open-ended rather than as "today"', () => {
    const old = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    setSaleTime(old.id, localMoment(2020, 1, 1, 11))
    const recent = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    setSaleTime(recent.id, localMoment(2026, 8, 24, 11))

    expect(getTodaysSalesSummary(db, owner, { from: '2026-01-01' }).salesTotal).toBe(500)
    expect(getTodaysSalesSummary(db, owner, { to: '2026-01-01' }).salesTotal).toBe(500)
    expect(getTodaysSalesSummary(db, owner, {}).salesTotal).toBe(1000)
  })

  /**
   * The reason `buildLocalDayRangeClause` converts with `'localtime'`.
   * `created_at` is UTC; the shop's day is not. On an IST machine both of
   * these rows are stored under a *different* UTC date than the local day
   * they belong to, and a bare `date(created_at)` would put the first on
   * yesterday's dashboard and the second on tomorrow's.
   */
  it('files a sale under the local day it happened on, not its UTC date', () => {
    const justAfterMidnight = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    setSaleTime(justAfterMidnight.id, localMoment(2026, 8, 24, 0, 30))
    const lateEvening = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    setSaleTime(lateEvening.id, localMoment(2026, 8, 24, 23, 30))
    const nightBefore = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    setSaleTime(nightBefore.id, localMoment(2026, 8, 23, 23, 30))

    const summary = getTodaysSalesSummary(db, owner, AUG_24)

    expect(summary.saleCount).toBe(2)
    expect(summary.salesTotal).toBe(1000)
  })

  it('files a Payment-In under its local day too', () => {
    const { payment } = recordPayment(db, salesman, { partyId, amount: 300, mode: 'cash' })
    setPaymentTime(payment.id, localMoment(2026, 8, 24, 0, 30))

    expect(getTodaysSalesSummary(db, owner, AUG_24).cashCollected).toBe(300)
    expect(
      getTodaysSalesSummary(db, owner, { from: '2026-08-23', to: '2026-08-23' }).cashCollected,
    ).toBe(0)
  })
})

/**
 * PHASE10.md section 4 / PHASE11.md acceptance criterion 5: enforced by the
 * *call*, not by what a screen renders.
 *
 * This is what makes the Owner password gate real rather than cosmetic. A
 * window that has not been unlocked is the counter session — role `salesman` —
 * and a renderer patched to mount the dashboard anyway reaches exactly this
 * check and gets nothing.
 *
 * It used to let a Salesman read their *own* figures via a `salesmanUserId`
 * argument. Both the argument and the concept are gone with the salesman login
 * (2026-08-27): every figure this returns is now shop-wide, so the only correct
 * answer for a counter session is refusal.
 */
describe('getTodaysSalesSummary — permission', () => {
  it('lets the counter read the shop-wide figure (Owner lock removed 2026-09-19)', () => {
    expect(() => getTodaysSalesSummary(db, salesman, AUG_24)).not.toThrow()
  })

  it('lets the Owner read the shop-wide figure', () => {
    expect(() => getTodaysSalesSummary(db, owner, AUG_24)).not.toThrow()
  })
})

describe('getSalesmanBreakdown', () => {
  beforeEach(() => {
    const anil = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    setSaleTime(anil.id, localMoment(2026, 8, 24, 10))
    const anilAgain = createSale(
      db,
      salesman,
      saleInput({
        partyId,
        items: [{ itemName: 'Blanket', quantity: 1, unitPrice: 900 }],
        paymentMode: 'split',
        cashAmount: 200,
        upiAmount: 300,
        creditAmount: 400,
      }),
    )
    setSaleTime(anilAgain.id, localMoment(2026, 8, 24, 16))
    const bhavna = createSale(
      db,
      otherSalesman,
      saleInput({
        items: [{ itemName: 'Shirt', quantity: 1, unitPrice: 700 }],
        paymentMode: 'upi',
        cashAmount: 0,
        upiAmount: 700,
      }),
    )
    setSaleTime(bhavna.id, localMoment(2026, 8, 24, 12))
  })

  it('attributes each sale to its salesman record, with that name', () => {
    const rows = getSalesmanBreakdown(db, owner, AUG_24)

    expect(rows).toEqual([
      {
        salesmanId,
        salesmanName: 'Anil Salesman',
        saleCount: 2,
        total: 1400,
        cashTotal: 700,
        upiTotal: 300,
        creditTotal: 400,
      },
      {
        salesmanId: otherSalesmanId,
        salesmanName: 'Bhavna Salesman',
        saleCount: 1,
        total: 700,
        cashTotal: 0,
        upiTotal: 700,
        creditTotal: 0,
      },
    ])
  })

  it("each row's cash, UPI and credit add up to that row's total", () => {
    for (const row of getSalesmanBreakdown(db, owner, AUG_24)) {
      expect(row.cashTotal + row.upiTotal + row.creditTotal).toBe(row.total)
    }
  })

  it('adds up to the shop-wide sales total for the same range', () => {
    const rows = getSalesmanBreakdown(db, owner, AUG_24)
    const summary = getTodaysSalesSummary(db, owner, AUG_24)

    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(summary.salesTotal)
    expect(rows.reduce((sum, row) => sum + row.saleCount, 0)).toBe(summary.saleCount)
  })

  it('omits anyone who made no sale in the range, rather than listing them at zero', () => {
    const rows = getSalesmanBreakdown(db, owner, AUG_24)

    expect(rows.map((row) => row.salesmanId)).not.toContain(ownerSalesmanId)
  })

  it('includes the Owner as a row when the Owner rang up the sale', () => {
    const byOwner = createSale(db, owner, saleInput({ cashAmount: 500 }))
    setSaleTime(byOwner.id, localMoment(2026, 8, 24, 9))

    const rows = getSalesmanBreakdown(db, owner, AUG_24)

    expect(rows.find((row) => row.salesmanId === ownerSalesmanId)).toMatchObject({
      salesmanName: 'Shop Owner',
      total: 500,
    })
  })

  it('excludes sales outside the range', () => {
    const yesterday = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    setSaleTime(yesterday.id, localMoment(2026, 8, 23, 11))

    const rows = getSalesmanBreakdown(db, owner, AUG_24)

    expect(rows.find((row) => row.salesmanId === salesmanId)!.total).toBe(1400)
  })

  it('returns an empty list for a range with no sales', () => {
    expect(getSalesmanBreakdown(db, owner, { from: '2026-09-01', to: '2026-09-01' })).toEqual([])
  })

  it('is open to a counter session — the Owner lock was removed 2026-09-19', () => {
    expect(() => getSalesmanBreakdown(db, salesman, AUG_24)).not.toThrow()
  })
})

describe('getOutstandingCreditTotal', () => {
  it('is 0 when nobody owes anything', () => {
    expect(getOutstandingCreditTotal(db, owner)).toBe(0)
  })

  it('sums every positive balance', () => {
    db.prepare(`UPDATE parties SET balance = 1500 WHERE id = ?`).run(partyId)
    db.prepare(
      `INSERT INTO parties (name, phone, balance, created_by_user_id) VALUES ('Sunita Fabrics', '9876500002', 250.5, ?)`,
    ).run(ownerId)

    expect(getOutstandingCreditTotal(db, owner)).toBe(1750.5)
  })

  it('ignores a party in credit, so an advance cannot cancel out another party’s debt', () => {
    db.prepare(`UPDATE parties SET balance = 1000 WHERE id = ?`).run(partyId)
    db.prepare(
      `INSERT INTO parties (name, phone, balance, created_by_user_id) VALUES ('Advance Payer', '9876500003', -400, ?)`,
    ).run(ownerId)

    expect(getOutstandingCreditTotal(db, owner)).toBe(1000)
  })

  it('tracks the live balance as a credit sale is made and then paid off', () => {
    createSale(
      db,
      salesman,
      saleInput({
        partyId,
        items: [{ itemName: 'Silk Saree', quantity: 1, unitPrice: 1000 }],
        paymentMode: 'credit',
        cashAmount: 0,
        upiAmount: 0,
        creditAmount: 1000,
      }),
    )
    expect(getOutstandingCreditTotal(db, owner)).toBe(1000)

    recordPayment(db, salesman, { partyId, amount: 400, mode: 'cash' })
    expect(getOutstandingCreditTotal(db, owner)).toBe(600)

    recordPayment(db, salesman, { partyId, amount: 600, mode: 'upi' })
    expect(getOutstandingCreditTotal(db, owner)).toBe(0)
  })

  it('is a live snapshot, unaffected by how old the credit sale is', () => {
    const sale = createSale(
      db,
      salesman,
      saleInput({
        partyId,
        items: [{ itemName: 'Old Bill', quantity: 1, unitPrice: 750 }],
        paymentMode: 'credit',
        cashAmount: 0,
        upiAmount: 0,
        creditAmount: 750,
      }),
    )
    setSaleTime(sale.id, localMoment(2020, 1, 1, 11))

    expect(getOutstandingCreditTotal(db, owner)).toBe(750)
  })

  it('is open to a counter session — the Owner lock was removed 2026-09-19', () => {
    expect(() => getOutstandingCreditTotal(db, salesman)).not.toThrow()
  })
})

describe('money rounding', () => {
  it('does not leak float drift into a summed total', () => {
    for (let i = 0; i < 10; i += 1) {
      const sale = createSale(
        db,
        salesman,
        saleInput({
          items: [{ itemName: 'Thread', quantity: 1, unitPrice: 0.1 }],
          cashAmount: 0.1,
        }),
      )
      setSaleTime(sale.id, localMoment(2026, 8, 24, 11))
    }

    const summary = getTodaysSalesSummary(db, owner, AUG_24)

    expect(summary.salesTotal).toBe(1)
    expect(summary.cashCollected).toBe(1)
    expect(getSalesmanBreakdown(db, owner, AUG_24)[0].total).toBe(1)
  })

  it('keeps the collected split adding up exactly as displayed', () => {
    const sale = createSale(
      db,
      salesman,
      saleInput({
        items: [{ itemName: 'Ribbon', quantity: 3, unitPrice: 0.1 }],
        paymentMode: 'split',
        cashAmount: 0.2,
        upiAmount: 0.1,
        creditAmount: 0,
      }),
    )
    setSaleTime(sale.id, localMoment(2026, 8, 24, 11))
    const { payment } = recordPayment(db, salesman, { partyId, amount: 0.2, mode: 'upi' })
    setPaymentTime(payment.id, localMoment(2026, 8, 24, 12))

    const summary = getTodaysSalesSummary(db, owner, AUG_24)

    expect(summary.cashCollected + summary.upiCollected).toBe(summary.totalCollected)
    expect(summary.upiCollected).toBe(0.3)
    expect(summary.totalCollected).toBe(0.5)
  })
})

/**
 * The dashboard builds one range and hands the same object to every figure it
 * shows. This pins that `DateRange` and Phase 9's `ExpenseListFilters` really
 * are interchangeable, so nobody has to convert between them — a conversion is
 * where a one-day drift between the sales figure and the expense figure would
 * come from.
 */
describe('one range object drives every dashboard figure', () => {
  it('scopes sales, payments and expenses to the same local day', () => {
    const today = todayIsoDate()
    const range = todayRange()

    const sale = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    const { payment } = recordPayment(db, salesman, { partyId, amount: 100, mode: 'upi' })
    logExpense(db, salesman, { category: 'Transport', amount: 80, date: today })
    logExpense(db, owner, { category: 'Rent', amount: 5000, date: '2020-01-01' })

    expect(range).toEqual({ from: today, to: today })
    expect(sale.created_at).toBeTruthy()
    expect(payment.created_at).toBeTruthy()

    const summary = getTodaysSalesSummary(db, owner, range)
    expect(summary.salesTotal).toBe(500)
    expect(summary.cashCollected).toBe(500)
    expect(summary.upiCollected).toBe(100)

    expect(getSalesmanBreakdown(db, owner, range)).toHaveLength(1)
    // The same object, unconverted, into Phase 9's total — the back-dated rent
    // is excluded, so this is genuinely the day's range and not "everything".
    expect(getExpensesTotal(db, range)).toBe(80)
  })
})

/**
 * The two dashboard composers (PHASE10.md sections 1-2). These are what the
 * `dashboard:owner` / `dashboard:salesman` IPC channels call, so what is proved
 * here is what a real session can and cannot reach.
 */
describe('getOwnerDashboard', () => {
  beforeEach(() => {
    const today = todayIsoDate()

    createSale(db, salesman, saleInput({ cashAmount: 500 }))
    createSale(
      db,
      otherSalesman,
      saleInput({
        partyId,
        items: [{ itemName: 'Silk Dupatta', quantity: 1, unitPrice: 900 }],
        paymentMode: 'split',
        cashAmount: 200,
        upiAmount: 300,
        creditAmount: 400,
      }),
    )
    recordPayment(db, salesman, { partyId, amount: 150, mode: 'upi' })
    logExpense(db, owner, { category: 'Rent', amount: 700, date: today })
    logExpense(db, owner, { category: 'Rent', amount: 9999, date: '2020-01-01' })
  })

  it('matches each primitive called directly for the same range', () => {
    const range = todayRange()
    const dashboard = getOwnerDashboard(db, owner, range)

    expect(dashboard.summary).toEqual(getTodaysSalesSummary(db, owner, range))
    expect(dashboard.salesmanBreakdown).toEqual(getSalesmanBreakdown(db, owner, range))
    expect(dashboard.outstandingCredit).toBe(getOutstandingCreditTotal(db, owner))
    expect(dashboard.expenseTotal).toBe(getExpensesTotal(db, range))
  })

  it('scopes the expense total to the same range as the sales figures', () => {
    // The back-dated ₹9999 rent is the guard against the range being dropped
    // on the way to `getExpensesTotal`, which treats an omitted range as all
    // time — that failure would look like a plausible number, not an error.
    const dashboard = getOwnerDashboard(db, owner, todayRange())

    expect(dashboard.expenseTotal).toBe(700)
  })

  it('echoes back the range it measured and stamps when it read the numbers', () => {
    const range = todayRange()
    const dashboard = getOwnerDashboard(db, owner, range)

    expect(dashboard.range).toEqual(range)
    expect(dashboard.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('is open to a counter session — the Owner lock was removed 2026-09-19', () => {
    expect(() => getOwnerDashboard(db, salesman, todayRange())).not.toThrow()
  })
})

/*
 * `getSalesmanDashboard`'s suite stood here until 2026-08-27. It proved that a
 * Salesman session saw its own day and never reached a shop-wide query. Both
 * the composer and the session type are gone: nobody logs in as a salesman, so
 * there is no "own day" to scope, and the shop-wide queries are guarded by the
 * Owner password gate instead. What replaced its central proof — that a
 * non-Owner session cannot reach shop-wide figures — is the
 * `getTodaysSalesSummary — permission` suite above.
 */

/* ========================================================================= *
 * Phase 11 — Reports (PHASE11.md section 6 acceptance criteria)
 * ========================================================================= */

const AUG_RANGE: DateRange = { from: '2026-08-01', to: '2026-08-31' }

/**
 * **Acceptance criterion 1, as a regression test rather than a manual
 * eyeball.**
 *
 * The criterion is that the Daily Sales Report narrowed to today produces
 * numbers identical to the Phase 10 Owner dashboard — the cross-check that the
 * generalized query didn't drift from the original. Checking it by hand once
 * proves it today; asserting the two summaries are deep-equal proves it on
 * every future run, and fails the moment someone gives either path its own
 * arithmetic.
 */
describe('getDailySalesReport — criterion 1: identical to the Owner dashboard for today', () => {
  beforeEach(() => {
    // A day with every ingredient the two could disagree about: cash, UPI,
    // a split with a credit component, and a Payment-In against older credit.
    createSale(db, salesman, saleInput({ cashAmount: 500 }))
    createSale(
      db,
      otherSalesman,
      saleInput({
        items: [{ itemName: 'Kurta', quantity: 2, unitPrice: 400 }],
        paymentMode: 'upi',
        cashAmount: 0,
        upiAmount: 800,
      }),
    )
    createSale(
      db,
      owner,
      saleInput({
        partyId,
        items: [{ itemName: 'Bedsheet', quantity: 1, unitPrice: 1000 }],
        paymentMode: 'split',
        cashAmount: 300,
        upiAmount: 200,
        creditAmount: 500,
      }),
    )
    recordPayment(db, salesman, { partyId, amount: 250, mode: 'cash', note: null })
  })

  it('produces a summary deep-equal to the dashboard for the same range', () => {
    const range = todayRange()

    expect(getDailySalesReport(db, owner, range).summary).toEqual(
      getOwnerDashboard(db, owner, range).summary,
    )
  })

  it('agrees field by field, including the halves of each split', () => {
    const range = todayRange()
    const report = getDailySalesReport(db, owner, range).summary
    const dashboard = getOwnerDashboard(db, owner, range).summary

    // Spelled out as well as deep-equalled: if these ever diverge, the failure
    // should name which figure drifted rather than dumping two objects.
    expect(report.salesTotal).toBe(dashboard.salesTotal)
    expect(report.cashFromSales).toBe(dashboard.cashFromSales)
    expect(report.cashFromPayments).toBe(dashboard.cashFromPayments)
    expect(report.upiFromSales).toBe(dashboard.upiFromSales)
    expect(report.upiFromPayments).toBe(dashboard.upiFromPayments)
    expect(report.creditIssued).toBe(dashboard.creditIssued)
    expect(report.creditCollected).toBe(dashboard.creditCollected)
    expect(report.cashCollected).toBe(dashboard.cashCollected)
    expect(report.upiCollected).toBe(dashboard.upiCollected)
    expect(report.totalCollected).toBe(dashboard.totalCollected)
  })

  it('is shop-wide, not scoped to the calling Owner', () => {
    // Both salesmen's sales are in it, so the report is not quietly filtered to
    // `user.id` the way the Salesman dashboard is.
    expect(getDailySalesReport(db, owner, todayRange()).summary.saleCount).toBe(3)
  })

  it('echoes back the range it measured', () => {
    expect(getDailySalesReport(db, owner, AUG_RANGE).range).toEqual(AUG_RANGE)
  })

  it('widens correctly — a back-dated sale appears in the month but not in today', () => {
    // Runs to today rather than to a fixed August date: today's sale below has
    // to sit inside the wide range for the arithmetic to hold, and a hardcoded
    // end date stopped containing it once the calendar moved on.
    const wide = { from: '2026-08-01', to: todayIsoDate() }
    const old = createSale(
      db,
      salesman,
      saleInput({ items: [{ itemName: 'Shawl', quantity: 1, unitPrice: 700 }], cashAmount: 700 }),
    )
    setSaleTime(old.id, localMoment(2026, 8, 3, 14))

    const today = getDailySalesReport(db, owner, todayRange()).summary
    const month = getDailySalesReport(db, owner, wide).summary

    expect(month.salesTotal).toBe(today.salesTotal + 700)
  })

  it('is readable by the counter — criterion 5 was reversed on 2026-09-19', () => {
    expect(() => getDailySalesReport(db, salesman, todayRange())).not.toThrow()
  })
})

/**
 * **Acceptance criterion 2** — the drill-down totals to its own breakdown row.
 */
describe('getSalesmanSales — the drill-down', () => {
  it('lists that salesman-s individual sales in the range, newest first', () => {
    const first = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    const second = createSale(
      db,
      salesman,
      saleInput({ items: [{ itemName: 'Kurta', quantity: 1, unitPrice: 300 }], cashAmount: 300 }),
    )
    setSaleTime(first.id, localMoment(2026, 8, 10, 9))
    setSaleTime(second.id, localMoment(2026, 8, 12, 9))

    const rows = getSalesmanSales(db, owner, salesmanId, AUG_RANGE)

    expect(rows.map((row) => row.saleId)).toEqual([second.id, first.id])
  })

  it('counts the line items on each bill without multiplying the total by them', () => {
    // The scalar-subquery-vs-JOIN trap: a fan-out would report grandTotal as
    // 3 x 900 here, and the drill-down would disagree with the row it opened.
    const sale = createSale(
      db,
      salesman,
      saleInput({
        items: [
          { itemName: 'Saree', quantity: 1, unitPrice: 400 },
          { itemName: 'Kurta', quantity: 1, unitPrice: 300 },
          { itemName: 'Dupatta', quantity: 1, unitPrice: 200 },
        ],
        cashAmount: 900,
      }),
    )
    setSaleTime(sale.id, localMoment(2026, 8, 10, 9))

    const [row] = getSalesmanSales(db, owner, salesmanId, AUG_RANGE)

    expect(row.itemCount).toBe(3)
    expect(row.grandTotal).toBe(900)
  })

  it('sums to that salesman-s total in getSalesmanBreakdown — criterion 2', () => {
    createSale(db, salesman, saleInput({ cashAmount: 500 }))
    createSale(
      db,
      salesman,
      saleInput({
        items: [{ itemName: 'Kurta', quantity: 2, unitPrice: 400 }],
        paymentMode: 'upi',
        cashAmount: 0,
        upiAmount: 800,
      }),
    )
    createSale(
      db,
      salesman,
      saleInput({
        partyId,
        items: [{ itemName: 'Bedsheet', quantity: 1, unitPrice: 1000 }],
        paymentMode: 'split',
        cashAmount: 300,
        upiAmount: 200,
        creditAmount: 500,
      }),
    )
    // A sale by someone else, which must not leak into either figure.
    createSale(db, otherSalesman, saleInput({ cashAmount: 500 }))

    const range = todayRange()
    const breakdownRow = getSalesmanBreakdown(db, owner, range).find(
      (row) => row.salesmanId === salesmanId,
    )
    const rows = getSalesmanSales(db, owner, salesmanId, range)

    expect(rows).toHaveLength(3)
    expect(rows.reduce((sum, row) => sum + row.grandTotal, 0)).toBe(breakdownRow?.total)
    expect(breakdownRow?.saleCount).toBe(rows.length)
  })

  it('returns a null party for a walk-in cash sale rather than dropping the row', () => {
    // `sales.party_id` is nullable and a walk-in is the ordinary case — an
    // inner join here would silently hide most of a day's cash sales.
    createSale(db, salesman, saleInput({ partyId: null, cashAmount: 500 }))

    const [row] = getSalesmanSales(db, owner, salesmanId, todayRange())

    expect(row.partyName).toBeNull()
    expect(row.grandTotal).toBe(500)
  })

  it('names the party on a credit sale', () => {
    createSale(
      db,
      salesman,
      saleInput({
        partyId,
        items: [{ itemName: 'Bedsheet', quantity: 1, unitPrice: 1000 }],
        paymentMode: 'credit',
        cashAmount: 0,
        creditAmount: 1000,
      }),
    )

    const [row] = getSalesmanSales(db, owner, salesmanId, todayRange())

    expect(row.partyName).toBe('Ramesh Textiles')
    expect(row.creditAmount).toBe(1000)
    expect(row.paymentMode).toBe('credit')
  })

  it('files a 00:30 sale under the local day, matching the breakdown it drills into', () => {
    // The same `date(col,'localtime')` clause the breakdown uses — if these two
    // ever disagreed on a day boundary, the drill-down would show a set of
    // sales that didn't add up to the row above it.
    const sale = createSale(db, salesman, saleInput({ cashAmount: 500 }))
    setSaleTime(sale.id, localMoment(2026, 8, 24, 0, 30))

    expect(getSalesmanSales(db, owner, salesmanId, AUG_24)).toHaveLength(1)
    expect(
      getSalesmanSales(db, owner, salesmanId, { from: '2026-08-23', to: '2026-08-23' }),
    ).toHaveLength(0)
  })

  it('does not fold in Payment-In rows, matching getSalesmanBreakdown', () => {
    createSale(db, salesman, saleInput({ cashAmount: 500 }))
    recordPayment(db, salesman, { partyId, amount: 250, mode: 'cash', note: null })

    // A payment is not a sale — this drills into a cell of the sales breakdown.
    expect(getSalesmanSales(db, owner, salesmanId, todayRange())).toHaveLength(1)
  })

  it('returns an empty list for a salesman with nothing in the range', () => {
    expect(getSalesmanSales(db, owner, otherSalesmanId, AUG_RANGE)).toEqual([])
  })

  it('is open to the counter — criterion 5 was reversed on 2026-09-19', () => {
    // Was deliberately stricter than getTodaysSalesSummary (PHASE11.md section 0:
    // "not even in a read-only capacity"). The Owner lock was removed on
    // 2026-09-19, so the drill-down is a read like every other report now.
    expect(() => getSalesmanSales(db, salesman, salesmanId, todayRange())).not.toThrow()
    expect(() => getSalesmanSales(db, salesman, otherSalesmanId, todayRange())).not.toThrow()
  })
})

/**
 * **Acceptance criterion 3** — every non-zero balance, sorted, reconciling with
 * `getOutstandingCreditTotal`.
 */
describe('getPartyOutstandingList / getPartyOutstandingReport', () => {
  function seedParty(name: string, phone: string | null, balance: number): number {
    return db
      .prepare(`INSERT INTO parties (name, phone, balance, created_by_user_id) VALUES (?, ?, ?, ?)`)
      .run(name, phone, balance, ownerId).lastInsertRowid as number
  }

  it('lists every party with a non-zero balance, biggest debt first', () => {
    seedParty('Suresh Cloth', '9876500002', 3100)
    seedParty('Meena Fabrics', null, 850)
    db.prepare('UPDATE parties SET balance = 12400 WHERE id = ?').run(partyId)

    expect(getPartyOutstandingList(db, owner).map((row) => [row.partyName, row.balance])).toEqual([
      ['Ramesh Textiles', 12400],
      ['Suresh Cloth', 3100],
      ['Meena Fabrics', 850],
    ])
  })

  it('includes an overpaid party, sorted last', () => {
    seedParty('Kiran Stores', '9876500003', -1200)
    db.prepare('UPDATE parties SET balance = 12400 WHERE id = ?').run(partyId)

    const rows = getPartyOutstandingList(db, owner)

    expect(rows.map((row) => row.partyName)).toEqual(['Ramesh Textiles', 'Kiran Stores'])
    expect(rows[1].balance).toBe(-1200)
  })

  it('omits a settled party', () => {
    seedParty('Settled Traders', '9876500009', 0)

    expect(getPartyOutstandingList(db, owner)).toEqual([])
  })

  it('omits a party left on a float residue rather than showing a phantom zero row', () => {
    // `adjustPartyBalance` (src/db/parties.ts) does `balance = balance + ?` in
    // SQL with **no rounding** — the one money path in this codebase that
    // doesn't go through `roundMoney`, because the running balance is
    // accumulated by the database.
    //
    // **Two credit sales, not one.** A single 400.10 sale settled by a single
    // 400.10 payment cancels to exactly 0 and would prove nothing (that was the
    // first version of this case). Two sales summed and then settled by one
    // payment is what leaves the residue: 100.10 + 200.20 - 300.30 lands on
    // about -5.7e-14. A bare `balance != 0` matches that and would carry a
    // fully-settled customer as an outstanding row rendering "₹0.00", sending
    // the Owner chasing a debt that doesn't exist.
    const drifty = seedParty('Drifty Traders', '9876500010', 0)
    for (const price of [100.1, 200.2]) {
      createSale(db, salesman, {
        partyId: drifty,
        items: [{ itemName: 'Saree', quantity: 1, unitPrice: price }],
        discount: 0,
        paymentMode: 'credit',
        cashAmount: 0,
        upiAmount: 0,
        creditAmount: price,
      })
    }
    recordPayment(db, salesman, { partyId: drifty, amount: 300.3, mode: 'cash', note: null })

    const raw = db.prepare('SELECT balance FROM parties WHERE id = ?').get(drifty) as {
      balance: number
    }
    // Guard the guard: this case only tests the trap while the stored balance
    // is a non-zero residue. If a future change makes it settle exactly, this
    // fails loudly rather than passing vacuously.
    expect(raw.balance).not.toBe(0)
    expect(Math.abs(raw.balance)).toBeLessThan(0.005)
    // And prove the naive predicate really would have picked it up.
    const naive = db
      .prepare('SELECT COUNT(*) AS c FROM parties WHERE id = ? AND balance != 0')
      .get(drifty) as { c: number }
    expect(naive.c).toBe(1)

    expect(getPartyOutstandingList(db, owner).map((row) => row.partyName)).not.toContain(
      'Drifty Traders',
    )
  })

  it('breaks a tie on name, so equal balances keep a stable order', () => {
    seedParty('Zara Cloth', null, 500)
    seedParty('Amrit Textiles', null, 500)

    expect(getPartyOutstandingList(db, owner).map((row) => row.partyName)).toEqual([
      'Amrit Textiles',
      'Zara Cloth',
    ])
  })

  it('carries the phone, null when none is on file', () => {
    seedParty('Meena Fabrics', null, 850)
    db.prepare('UPDATE parties SET balance = 12400 WHERE id = ?').run(partyId)

    const rows = getPartyOutstandingList(db, owner)

    expect(rows[0].phone).toBe('9876500001')
    expect(rows[1].phone).toBeNull()
  })

  it('reports a total matching getOutstandingCreditTotal — criterion 3', () => {
    seedParty('Suresh Cloth', '9876500002', 3100)
    seedParty('Meena Fabrics', null, 850)
    seedParty('Kiran Stores', '9876500003', -1200)
    db.prepare('UPDATE parties SET balance = 12400 WHERE id = ?').run(partyId)

    const report = getPartyOutstandingReport(db, owner)

    expect(report.outstandingTotal).toBe(getOutstandingCreditTotal(db, owner))
    expect(report.outstandingTotal).toBe(16350)
  })

  it('totals the positive rows only — an advance must not cancel out a debt', () => {
    seedParty('Kiran Stores', '9876500003', -1200)
    db.prepare('UPDATE parties SET balance = 12400 WHERE id = ?').run(partyId)

    const report = getPartyOutstandingReport(db, owner)
    const positives = report.rows
      .filter((row) => row.balance > 0)
      .reduce((sum, row) => sum + row.balance, 0)
    const all = report.rows.reduce((sum, row) => sum + row.balance, 0)

    expect(report.outstandingTotal).toBe(positives)
    // Explicitly *not* the sum of every row — that is the distinction the
    // screen labels rather than leaving a reader to trip over.
    expect(report.outstandingTotal).not.toBe(all)
  })

  it('is a live snapshot — a Payment-In moves it immediately', () => {
    db.prepare('UPDATE parties SET balance = 1000 WHERE id = ?').run(partyId)
    expect(getPartyOutstandingReport(db, owner).outstandingTotal).toBe(1000)

    recordPayment(db, salesman, { partyId, amount: 400, mode: 'cash', note: null })

    expect(getPartyOutstandingReport(db, owner).outstandingTotal).toBe(600)
  })

  it('is open to the counter — criterion 5 was reversed on 2026-09-19', () => {
    expect(() => getPartyOutstandingList(db, salesman)).not.toThrow()
    expect(() => getPartyOutstandingReport(db, salesman)).not.toThrow()
  })
})

describe('getSalesmanReport — the breakdown composer', () => {
  it('wraps getSalesmanBreakdown unchanged and echoes its range', () => {
    createSale(db, salesman, saleInput({ cashAmount: 500 }))
    createSale(
      db,
      otherSalesman,
      saleInput({ items: [{ itemName: 'Kurta', quantity: 1, unitPrice: 300 }], cashAmount: 300 }),
    )

    const range = todayRange()
    const report = getSalesmanReport(db, owner, range)

    expect(report.range).toEqual(range)
    expect(report.rows).toEqual(getSalesmanBreakdown(db, owner, range))
    expect(report.rows).toHaveLength(2)
  })

  it('is open to the counter — criterion 5 was reversed on 2026-09-19', () => {
    expect(() => getSalesmanReport(db, salesman, todayRange())).not.toThrow()
  })
})

/**
 * The permission gate is the *only* thing standing between a patched renderer
 * and this data, since the preload surface is shared and built before login —
 * so criterion 5 gets a sweep over every Phase 11 entry point rather than
 * trusting each describe block above to have remembered its own case.
 */
describe('criterion 5 — no Phase 11 report function is reachable from a Salesman session', () => {
  it('lets the counter read every one of them, since the screens are open — writes are what stay Owner-only', () => {
    const range = todayRange()
    expect(() => getSalesLedger(db, salesman, range)).not.toThrow()

    expect(() => getDailySalesReport(db, salesman, range)).not.toThrow()
    expect(() => getSalesmanReport(db, salesman, range)).not.toThrow()
    expect(() => getSalesmanSales(db, salesman, salesmanId, range)).not.toThrow()
    expect(() => getPartyOutstandingList(db, salesman)).not.toThrow()
    expect(() => getPartyOutstandingReport(db, salesman)).not.toThrow()
  })

  it('allows every one of them for an Owner, so the rejections above are about role and nothing else', () => {
    const range = todayRange()

    expect(() => getDailySalesReport(db, owner, range)).not.toThrow()
    expect(() => getSalesmanReport(db, owner, range)).not.toThrow()
    expect(() => getSalesmanSales(db, owner, salesmanId, range)).not.toThrow()
    expect(() => getPartyOutstandingList(db, owner)).not.toThrow()
    expect(() => getPartyOutstandingReport(db, owner)).not.toThrow()
  })
})

/**
 * The counter can *read* every report now; what it must still never do is
 * change or destroy anything. The per-action Owner password in the renderer is
 * only how an Owner asks - these are the assertions that make it mean something.
 */
describe('writes stay Owner-only after the Owner lock was removed', () => {
  it.each([
    'party:edit',
    'party:delete',
    'settings:edit',
    'salesman:manage',
    'user:manage',
    'backup:run',
    'backup:restore',
    'retention:run',
    'sale:print_override',
    'whatsapp:manage_session',
    'sale:edit',
    'sale:delete',
    'expense:edit',
    'expense:delete',
  ] as const)('rejects a counter session for %s', (action) => {
    expect(() => assertPermission('salesman', action)).toThrow(PermissionError)
    expect(() => assertPermission('owner', action)).not.toThrow()
  })

  it.each(['backup:view', 'retention:view', 'report:view_all', 'whatsapp:view_deliveries', 'whatsapp:resend_bill'] as const)(
    'lets a counter session use the read-only %s',
    (action) => {
      expect(() => assertPermission('salesman', action)).not.toThrow()
    },
  )
})
