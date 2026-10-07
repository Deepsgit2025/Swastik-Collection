// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adjustPartyBalance,
  createParty,
  deleteParty,
  getParties,
  getPartyById,
  getPartyLedger,
  quickAddParty,
  updateParty,
} from './parties.ts'
import { PermissionError } from './permissions.ts'
import type { SafeUser } from '../types/user.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let ownerId: number
let salesmanId: number
let partyId: number
let otherPartyId: number
let owner: SafeUser
let salesman: SafeUser

/**
 * The Sale and Payment-In modules don't exist until Phases 5 and 8, so this
 * mirrors PHASE3.md's instruction: insert directly into `sales`/`payments`
 * (bypassing any UI/write function) to prove the ledger query's combined,
 * chronological, running-balance logic against real schema shapes.
 */
function insertSale(
  opts: { partyId: number; creditAmount: number; paymentMode: string; createdAt: string; grandTotal?: number },
): void {
  db.prepare(
    `INSERT INTO sales
       (party_id, salesman_user_id, payment_mode, cash_amount, upi_amount, credit_amount,
        subtotal, total_discount, grand_total, is_cash_bill, created_at)
     VALUES (?, ?, ?, 0, 0, ?, ?, 0, ?, ?, ?)`,
  ).run(
    opts.partyId,
    ownerId,
    opts.paymentMode,
    opts.creditAmount,
    opts.grandTotal ?? opts.creditAmount,
    opts.grandTotal ?? opts.creditAmount,
    opts.paymentMode === 'credit' || opts.paymentMode === 'split' ? 0 : 1,
    opts.createdAt,
  )
}

function insertPayment(opts: { partyId: number; amount: number; mode: string; createdAt: string }): void {
  db.prepare(
    `INSERT INTO payments (party_id, amount, mode, recorded_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.partyId, opts.amount, opts.mode, ownerId, opts.createdAt)
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/001_init.sql'), 'utf-8'))
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/002_core_schema.sql'), 'utf-8'))

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
    .prepare(
      `INSERT INTO parties (name, phone, address, balance, created_by_user_id) VALUES ('Sunita Fabrics', '9876500002', 'FC Road', 0, ?)`,
    )
    .run(ownerId).lastInsertRowid as number

  otherPartyId = db
    .prepare(
      `INSERT INTO parties (name, phone, address, balance, created_by_user_id) VALUES ('Verma Textiles', '9876500003', null, 0, ?)`,
    )
    .run(ownerId).lastInsertRowid as number
})

describe('getPartyLedger', () => {
  it('combines sales and payments into one chronological, running-balance view', () => {
    // Inserted out of chronological order on purpose, to prove the query sorts by date, not insert order.
    insertPayment({ partyId, amount: 500, mode: 'cash', createdAt: '2026-01-10 09:00:00' })
    insertSale({ partyId, creditAmount: 2000, paymentMode: 'credit', createdAt: '2026-01-05 10:00:00' })
    insertSale({ partyId, creditAmount: 0, paymentMode: 'cash', grandTotal: 300, createdAt: '2026-01-06 11:00:00' })
    insertPayment({ partyId, amount: 800, mode: 'upi', createdAt: '2026-01-15 12:00:00' })

    const result = getPartyLedger(db, partyId)

    expect(result).not.toBeNull()
    expect(result!.party.name).toBe('Sunita Fabrics')
    expect(result!.entries).toHaveLength(4)

    // Chronological order, regardless of insert order.
    expect(result!.entries.map((e) => e.date)).toEqual([
      '2026-01-05 10:00:00',
      '2026-01-06 11:00:00',
      '2026-01-10 09:00:00',
      '2026-01-15 12:00:00',
    ])

    // Credit sale (+2000), cash sale (+0, no balance impact), payment (-500), payment (-800).
    expect(result!.entries.map((e) => e.amount)).toEqual([2000, 0, -500, -800])
    expect(result!.entries.map((e) => e.runningBalance)).toEqual([2000, 2000, 1500, 700])

    // billAmount reflects what was actually billed/paid, not the balance delta —
    // the ₹300 cash sale still shows its real bill total here, not ₹0.
    expect(result!.entries.map((e) => e.billAmount)).toEqual([2000, 300, 500, 800])

    expect(result!.entries[0].type).toBe('sale')
    expect(result!.entries[2].type).toBe('payment')
  })

  it('only includes rows linked to the requested party', () => {
    insertSale({ partyId, creditAmount: 1000, paymentMode: 'credit', createdAt: '2026-01-01 00:00:00' })
    insertSale({ partyId: otherPartyId, creditAmount: 5000, paymentMode: 'credit', createdAt: '2026-01-01 00:00:00' })
    insertPayment({ partyId: otherPartyId, amount: 200, mode: 'cash', createdAt: '2026-01-02 00:00:00' })

    const result = getPartyLedger(db, partyId)

    expect(result!.entries).toHaveLength(1)
    expect(result!.entries[0].runningBalance).toBe(1000)
  })

  it('returns an empty entries list for a party with no sales or payments yet', () => {
    const result = getPartyLedger(db, partyId)
    expect(result!.entries).toEqual([])
  })

  it('returns null for a party id that does not exist', () => {
    expect(getPartyLedger(db, 999999)).toBeNull()
  })

  it('breaks same-timestamp ties deterministically (sale before payment)', () => {
    insertPayment({ partyId, amount: 100, mode: 'cash', createdAt: '2026-02-01 09:00:00' })
    insertSale({ partyId, creditAmount: 400, paymentMode: 'credit', createdAt: '2026-02-01 09:00:00' })

    const result = getPartyLedger(db, partyId)

    expect(result!.entries.map((e) => e.type)).toEqual(['sale', 'payment'])
    expect(result!.entries.map((e) => e.runningBalance)).toEqual([400, 300])
  })
})

describe('getParties', () => {
  beforeEach(() => {
    db.prepare(`UPDATE parties SET balance = 4500 WHERE id = ?`).run(partyId)
  })

  it('lists all parties alphabetically by default', () => {
    const rows = getParties(db)
    expect(rows.map((r) => r.name)).toEqual(['Sunita Fabrics', 'Verma Textiles'])
  })

  it('filters by name or phone search', () => {
    expect(getParties(db, { search: 'sunita' }).map((r) => r.name)).toEqual(['Sunita Fabrics'])
    expect(getParties(db, { search: '9876500003' }).map((r) => r.name)).toEqual(['Verma Textiles'])
    expect(getParties(db, { search: 'nonexistent' })).toEqual([])
  })

  it('filters to only parties with a non-zero balance due', () => {
    const rows = getParties(db, { onlyWithBalanceDue: true })
    expect(rows.map((r) => r.name)).toEqual(['Sunita Fabrics'])
  })
})

describe('createParty', () => {
  it('creates a full record for Owner, including address and opening balance', () => {
    const party = createParty(db, owner, {
      name: 'New Traders',
      phone: '9000000000',
      address: 'Camp Road',
      openingBalance: 250,
    })

    expect(party.name).toBe('New Traders')
    expect(party.phone).toBe('9000000000')
    expect(party.address).toBe('Camp Road')
    expect(party.balance).toBe(250)
    expect(getPartyById(db, party.id)).not.toBeNull()
  })

  it('defaults balance to 0 and phone/address to null when omitted', () => {
    const party = createParty(db, owner, { name: 'Bare Minimum' })
    expect(party.balance).toBe(0)
    expect(party.phone).toBeNull()
    expect(party.address).toBeNull()
  })

  it('is technically callable by Salesman too — party:create allows both roles per Phase 2\'s table (field-level restriction is UI-layer, not this function)', () => {
    expect(() => createParty(db, salesman, { name: 'Should Still Work', phone: '9111111111' })).not.toThrow()
  })

  it('rejects a blank name', () => {
    expect(() => createParty(db, owner, { name: '   ' })).toThrow('Party name is required')
  })
})

describe('quickAddParty', () => {
  it('creates a name+phone-only record and works for Salesman', () => {
    const party = quickAddParty(db, salesman, { name: 'Mid-Sale Customer', phone: '9222222222' })

    expect(party.name).toBe('Mid-Sale Customer')
    expect(party.phone).toBe('9222222222')
    expect(party.address).toBeNull()
    expect(party.balance).toBe(0)
  })

  it('also works for Owner (row 2 of the section 2 table: Owner can use quick-add too)', () => {
    expect(() => quickAddParty(db, owner, { name: 'Owner Quick Add', phone: '9333333333' })).not.toThrow()
  })

  it('rejects a blank name or phone', () => {
    expect(() => quickAddParty(db, salesman, { name: '', phone: '9000000000' })).toThrow('Party name is required')
    expect(() => quickAddParty(db, salesman, { name: 'No Phone', phone: '  ' })).toThrow('Phone is required')
  })
})

describe('updateParty', () => {
  it('lets Owner edit name, phone, and address', () => {
    const updated = updateParty(db, owner, partyId, {
      name: 'Sunita Fabrics Renamed',
      phone: '9876500099',
      address: 'New Address',
    })

    expect(updated.name).toBe('Sunita Fabrics Renamed')
    expect(updated.phone).toBe('9876500099')
    expect(updated.address).toBe('New Address')
  })

  it('never touches balance — that only moves via adjustPartyBalance', () => {
    db.prepare('UPDATE parties SET balance = 777 WHERE id = ?').run(partyId)
    const updated = updateParty(db, owner, partyId, { name: 'Still Sunita' })
    expect(updated.balance).toBe(777)
  })

  it('throws PermissionError for Salesman, as a direct backend call, without touching the row', () => {
    expect(() => updateParty(db, salesman, partyId, { name: 'Hacked Name' })).toThrow(PermissionError)
    expect(getPartyById(db, partyId)!.name).toBe('Sunita Fabrics')
  })

  it('throws for a party id that does not exist', () => {
    expect(() => updateParty(db, owner, 999999, { name: 'Ghost' })).toThrow('not found')
  })
})

describe('adjustPartyBalance', () => {
  it('applies a credit-sale-style increase then a payment-style decrease, ending with the correct balance', () => {
    expect(getPartyById(db, partyId)!.balance).toBe(0)

    const afterSale = adjustPartyBalance(db, partyId, 2000)
    expect(afterSale.balance).toBe(2000)

    const afterPayment = adjustPartyBalance(db, partyId, -800)
    expect(afterPayment.balance).toBe(1200)

    expect(getPartyById(db, partyId)!.balance).toBe(1200)
  })

  it('leaves other parties untouched', () => {
    adjustPartyBalance(db, partyId, 500)
    expect(getPartyById(db, otherPartyId)!.balance).toBe(0)
  })

  it('throws for a party id that does not exist', () => {
    expect(() => adjustPartyBalance(db, 999999, 100)).toThrow('not found')
  })
})

describe('deleteParty', () => {
  it('lets Owner delete a party', () => {
    deleteParty(db, owner, otherPartyId)
    expect(getPartyById(db, otherPartyId)).toBeNull()
  })

  it('throws PermissionError for Salesman, as a direct backend call, without deleting the row', () => {
    expect(() => deleteParty(db, salesman, otherPartyId)).toThrow(PermissionError)
    expect(getPartyById(db, otherPartyId)).not.toBeNull()
  })

  it('throws for a party id that does not exist', () => {
    expect(() => deleteParty(db, owner, 999999)).toThrow('not found')
  })
})
