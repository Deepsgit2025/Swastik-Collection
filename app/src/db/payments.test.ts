// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPaymentById, recordPayment } from './payments.ts'
import { getPartyById, getPartyLedger } from './parties.ts'
import { PermissionError } from './permissions.ts'
import type { SafeUser } from '../types/user.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let ownerId: number
let salesmanId: number
let partyId: number
let owner: SafeUser
let salesman: SafeUser

beforeEach(() => {
  db = new Database(':memory:')
  for (const file of ['001_init.sql', '002_core_schema.sql']) {
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

  partyId = db
    .prepare(`INSERT INTO parties (name, phone, balance, created_by_user_id) VALUES ('Ramesh', '9876500001', 1000, ?)`)
    .run(ownerId).lastInsertRowid as number
})

/** PHASE8.md acceptance criterion 1 + section 2 steps 2–4. */
describe('recordPayment', () => {
  it('inserts the payment and reduces the party balance by the amount', () => {
    const result = recordPayment(db, owner, { partyId, amount: 400, mode: 'cash', note: 'part payment' })

    expect(result.payment).toMatchObject({
      party_id: partyId,
      amount: 400,
      mode: 'cash',
      note: 'part payment',
      recorded_by_user_id: ownerId,
    })
    // Returned party is already adjusted, so the UI needs no refetch (step 4).
    expect(result.party.balance).toBe(600)
    expect(getPartyById(db, partyId)!.balance).toBe(600)
  })

  it('accumulates across repeated payments and can take a balance to zero', () => {
    recordPayment(db, owner, { partyId, amount: 600, mode: 'upi' })
    const second = recordPayment(db, salesman, { partyId, amount: 400, mode: 'cash' })

    expect(second.party.balance).toBe(0)
  })

  it('stores an omitted or blank note as NULL rather than an empty string', () => {
    const noNote = recordPayment(db, owner, { partyId, amount: 100, mode: 'cash' })
    const blankNote = recordPayment(db, owner, { partyId, amount: 100, mode: 'cash', note: '   ' })

    expect(noNote.payment.note).toBeNull()
    expect(blankNote.payment.note).toBeNull()
  })

  it('records the UPI mode as given', () => {
    const result = recordPayment(db, owner, { partyId, amount: 250, mode: 'upi' })
    expect(result.payment.mode).toBe('upi')
  })
})

/** PHASE8.md acceptance criterion 3 — both roles can record a payment. */
describe('recordPayment permissions', () => {
  it('allows a Salesman to record a payment', () => {
    const result = recordPayment(db, salesman, { partyId, amount: 300, mode: 'cash' })

    expect(result.payment.recorded_by_user_id).toBe(salesmanId)
    expect(result.party.balance).toBe(700)
  })

  it('allows an Owner to record a payment', () => {
    const result = recordPayment(db, owner, { partyId, amount: 300, mode: 'cash' })

    expect(result.payment.recorded_by_user_id).toBe(ownerId)
    expect(result.party.balance).toBe(700)
  })
})

/**
 * PHASE8.md acceptance criterion 5 — an invalid amount or party is rejected
 * before anything reaches the database. The screen runs the same validators
 * inline (src/lib/paymentMath.ts), but these are the calls that actually gate
 * the write, so a modified renderer can't get past them either.
 */
describe('recordPayment validation', () => {
  it.each([0, -50])('rejects an amount of %s without inserting or moving the balance', (amount) => {
    expect(() => recordPayment(db, owner, { partyId, amount, mode: 'cash' })).toThrow(/greater than 0/i)

    expect(db.prepare('SELECT COUNT(*) AS n FROM payments').get()).toEqual({ n: 0 })
    expect(getPartyById(db, partyId)!.balance).toBe(1000)
  })

  it('rejects a party id that does not exist, without inserting', () => {
    expect(() => recordPayment(db, owner, { partyId: 9999, amount: 100, mode: 'cash' })).toThrow(
      /Party 9999 not found/,
    )

    expect(db.prepare('SELECT COUNT(*) AS n FROM payments').get()).toEqual({ n: 0 })
  })

  it('rejects a missing party id, without inserting', () => {
    expect(() =>
      recordPayment(db, owner, { partyId: null as unknown as number, amount: 100, mode: 'cash' }),
    ).toThrow(/Select the party/i)

    expect(db.prepare('SELECT COUNT(*) AS n FROM payments').get()).toEqual({ n: 0 })
  })

  it('rejects a mode other than cash or UPI before the table CHECK constraint would', () => {
    expect(() =>
      recordPayment(db, owner, { partyId, amount: 100, mode: 'credit' as unknown as 'cash' }),
    ).toThrow(/Cash or UPI/i)

    expect(db.prepare('SELECT COUNT(*) AS n FROM payments').get()).toEqual({ n: 0 })
  })

  it('rejects a Salesman-forged call to an Owner-only action only, not this one — payment:create stays allowed', () => {
    // Guards the section 4 table from drifting: if `payment:create` were ever
    // narrowed to Owner, this would start throwing PermissionError.
    expect(() => recordPayment(db, salesman, { partyId, amount: 100, mode: 'cash' })).not.toThrow(PermissionError)
  })
})

/**
 * PHASE8.md section 3 / acceptance criterion 4 — real payment rows now flow
 * into Phase 3's existing combined ledger query. Not a rebuild of that query,
 * just proof the integration holds now that `recordPayment` is what creates
 * the rows.
 */
describe('Party Ledger integration', () => {
  it('shows a recorded payment in the ledger with a reduced running balance', () => {
    db.prepare(
      `INSERT INTO sales (party_id, salesman_user_id, payment_mode, cash_amount, upi_amount, credit_amount,
         subtotal, total_discount, grand_total, is_cash_bill, created_at)
       VALUES (?, ?, 'credit', 0, 0, 1000, 1000, 0, 1000, 0, '2026-08-20 10:00:00')`,
    ).run(partyId, ownerId)

    recordPayment(db, owner, { partyId, amount: 400, mode: 'cash' })

    const ledger = getPartyLedger(db, partyId)!
    expect(ledger.entries.map((entry) => entry.type)).toEqual(['sale', 'payment'])
    expect(ledger.entries[1]).toMatchObject({ type: 'payment', amount: -400, billAmount: 400 })
    expect(ledger.entries[1].runningBalance).toBe(600)
    expect(ledger.party.balance).toBe(600)
  })
})

describe('getPaymentById', () => {
  it('returns null for an id that does not exist', () => {
    expect(getPaymentById(db, 12345)).toBeNull()
  })
})
