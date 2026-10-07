// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSale, getSaleById, markSalePrinted, usePrintOverride } from './sales.ts'
import { getPartyById } from './parties.ts'
import { PermissionError } from './permissions.ts'
import type { SafeUser } from '../types/user.ts'
import type { CreateSaleInput } from '../types/sale.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let ownerId: number
let salesmanId: number
let partyId: number
let owner: SafeUser
let salesman: SafeUser

beforeEach(() => {
  db = new Database(':memory:')
  // Every migration, in order, rather than the hand-picked subset this file
  // named until 2026-08-27. A named list breaks whenever a query grows a
  // dependency it does not know about — as it did when `createSale` started
  // writing `sales.salesman_id` — which is a maintenance cost with no matching
  // benefit. Same approach `reports.test.ts` already documents.
  const migrationsDir = path.join(__dirname, 'migrations')
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'))
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
    .prepare(
      `INSERT INTO parties (name, phone, address, balance, created_by_user_id) VALUES ('Sunita Fabrics', '9876500002', 'FC Road', 0, ?)`,
    )
    .run(ownerId).lastInsertRowid as number
})

function baseInput(overrides: Partial<CreateSaleInput> = {}): CreateSaleInput {
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

describe('createSale', () => {
  it('saves a cash sale with a single item, no discount, no party (acceptance criterion 1)', () => {
    const sale = createSale(db, owner, baseInput())

    expect(sale.id).toBeGreaterThan(0)
    expect(sale.party_id).toBeNull()
    expect(sale.subtotal).toBe(500)
    expect(sale.total_discount).toBe(0)
    expect(sale.grand_total).toBe(500)
    expect(sale.is_cash_bill).toBe(1)
    expect(sale.purge_at).not.toBeNull()
    expect(sale.items).toHaveLength(1)
    expect(sale.items[0].line_total).toBe(500)

    const persisted = getSaleById(db, sale.id)
    expect(persisted).not.toBeNull()
    expect(persisted!.items).toHaveLength(1)
  })

  it('requires a party for a credit sale and increases its balance by the credit amount (acceptance criterion 2)', () => {
    const sale = createSale(
      db,
      owner,
      baseInput({ partyId, paymentMode: 'credit', cashAmount: 0, upiAmount: 0, creditAmount: 500 }),
    )

    expect(sale.party_id).toBe(partyId)
    expect(sale.is_cash_bill).toBe(0)
    expect(getPartyById(db, partyId)!.balance).toBe(500)
  })

  it('rejects a credit sale with no party', () => {
    expect(() =>
      createSale(db, owner, baseInput({ paymentMode: 'credit', cashAmount: 0, upiAmount: 0, creditAmount: 500 })),
    ).toThrow('A party is required')
  })

  it('saves a split cash+UPI sale (no credit) as a cash bill (acceptance criterion 3)', () => {
    const sale = createSale(
      db,
      owner,
      baseInput({
        items: [{ itemName: 'Silk Dupatta', quantity: 1, unitPrice: 800 }],
        paymentMode: 'split',
        cashAmount: 500,
        upiAmount: 300,
        creditAmount: 0,
      }),
    )

    expect(sale.cash_amount).toBe(500)
    expect(sale.upi_amount).toBe(300)
    expect(sale.credit_amount).toBe(0)
    expect(sale.is_cash_bill).toBe(1)
  })

  it('saves a split sale with a credit component as not a cash bill, and still requires/links a party (acceptance criterion 4)', () => {
    const sale = createSale(
      db,
      owner,
      baseInput({
        partyId,
        items: [{ itemName: 'Kurta Set', quantity: 1, unitPrice: 500 }],
        paymentMode: 'split',
        cashAmount: 200,
        upiAmount: 0,
        creditAmount: 300,
      }),
    )

    expect(sale.party_id).toBe(partyId)
    expect(sale.is_cash_bill).toBe(0)
    expect(getPartyById(db, partyId)!.balance).toBe(300)
  })

  it('reduces the grand total by the bill-level discount, and rejects a discount exceeding the subtotal (acceptance criterion 5)', () => {
    const sale = createSale(
      db,
      owner,
      baseInput({
        items: [{ itemName: 'Discounted Item', quantity: 2, unitPrice: 100 }],
        discount: 50,
        cashAmount: 150,
      }),
    )
    expect(sale.subtotal).toBe(200)
    expect(sale.total_discount).toBe(50)
    expect(sale.grand_total).toBe(150)
    // The line item itself is untouched by the bill-level discount.
    expect(sale.items[0].line_total).toBe(200)

    expect(() =>
      createSale(
        db,
        owner,
        baseInput({
          items: [{ itemName: 'Over-discounted Item', quantity: 1, unitPrice: 100 }],
          discount: 150,
          cashAmount: -50,
        }),
      ),
    ).toThrow(/cannot exceed the subtotal/)
  })

  it('lets both Owner and Salesman complete a sale, with Salesman able to override price (acceptance criterion 7)', () => {
    const sale = createSale(
      db,
      salesman,
      baseInput({
        items: [{ itemName: 'Overridden Price Item', quantity: 1, unitPrice: 999 }],
        discount: 100,
        cashAmount: 899,
      }),
    )
    expect(sale.salesman_user_id).toBe(salesmanId)
    expect(sale.items[0].unit_price).toBe(999)
    expect(sale.total_discount).toBe(100)
  })

  it('rejects a sale whose cash+UPI+credit does not equal the grand total, before writing anything (acceptance criterion 8)', () => {
    const before = db.prepare('SELECT COUNT(*) AS count FROM sales').get() as { count: number }

    expect(() =>
      createSale(db, owner, baseInput({ paymentMode: 'split', cashAmount: 200, upiAmount: 200, creditAmount: 0 })),
    ).toThrow(/must exactly equal the grand total/)

    const after = db.prepare('SELECT COUNT(*) AS count FROM sales').get() as { count: number }
    expect(after.count).toBe(before.count)
  })

  it('rejects an empty cart', () => {
    expect(() => createSale(db, owner, baseInput({ items: [] }))).toThrow('At least one item is required')
  })

  it('rejects a negative discount', () => {
    expect(() => createSale(db, owner, baseInput({ discount: -10 }))).toThrow('Discount cannot be negative')
  })

  it('rejects a payment amount that does not match the recomputed grand total, even if the client tries to under-report it', () => {
    // Server always recomputes subtotal/discount/grand total from raw item
    // fields — there's no client-sent total to spoof, but this proves a
    // mismatched cash amount against the true grand total is still caught.
    expect(() =>
      createSale(
        db,
        owner,
        baseInput({
          items: [{ itemName: 'Real Price Item', quantity: 1, unitPrice: 1000 }],
          cashAmount: 1, // nowhere near the real grand total of 1000
        }),
      ),
    ).toThrow(/must exactly equal the grand total/)
  })

  it('throws PermissionError for a forged/invalid role, proving assertPermission is actually called', () => {
    const forged = { ...owner, role: 'accountant' } as unknown as SafeUser
    expect(() => createSale(db, forged, baseInput())).toThrow(PermissionError)
  })

  it('returns a full record with items, ready for Phase 6 to use for WhatsApp bill content', () => {
    const sale = createSale(
      db,
      owner,
      baseInput({
        items: [
          { itemName: 'Item A', quantity: 1, unitPrice: 100 },
          { itemName: 'Item B', quantity: 2, unitPrice: 50 },
        ],
        discount: 10,
        cashAmount: 190,
      }),
    )
    expect(sale.items).toHaveLength(2)
    expect(sale.subtotal).toBe(200)
    expect(sale.total_discount).toBe(10)
    expect(sale.grand_total).toBe(190)
  })
})

describe('markSalePrinted (PHASE7.md section 2 — permission enforcement; the delivery gate was removed 2026-08-24)', () => {
  // These two pin the reversal deliberately, rather than having been deleted
  // along with the rule they used to protect. Printing a bill whose WhatsApp
  // copies have not landed is now the *supported* path — a resyncing session
  // was otherwise stopping the counter with a customer stood waiting — and the
  // bill is queued for automatic retry instead (`retryPendingBills`).
  it('allows printing when neither WhatsApp flag is true, since the send is queued rather than awaited', () => {
    const sale = createSale(db, owner, baseInput())
    const printed = markSalePrinted(db, owner, sale.id)
    expect(printed.printed).toBe(1)
    // The flags are untouched by printing: they are still what the retry queue
    // and the undelivered count read, so printing must not look like delivery.
    expect(printed.whatsapp_owner_sent).toBe(0)
    expect(printed.whatsapp_customer_sent).toBe(0)
  })

  it('allows printing when only one of the two WhatsApp flags is true', () => {
    const sale = createSale(db, owner, baseInput())
    db.prepare('UPDATE sales SET whatsapp_owner_sent = 1 WHERE id = ?').run(sale.id)
    expect(markSalePrinted(db, owner, sale.id).printed).toBe(1)
  })

  it('sets printed = true once both WhatsApp flags are true (acceptance criterion 3), for either role', () => {
    const sale = createSale(db, salesman, baseInput())
    db.prepare('UPDATE sales SET whatsapp_customer_sent = 1, whatsapp_owner_sent = 1 WHERE id = ?').run(sale.id)

    const printed = markSalePrinted(db, salesman, sale.id)
    expect(printed.printed).toBe(1)
    expect(getSaleById(db, sale.id)!.printed).toBe(1)
  })

  it('allows printing once an override was used, even with both flags still false', () => {
    const sale = createSale(db, owner, baseInput())
    usePrintOverride(db, owner, sale.id)

    const printed = markSalePrinted(db, owner, sale.id)
    expect(printed.printed).toBe(1)
  })

  it('throws for a nonexistent sale id', () => {
    expect(() => markSalePrinted(db, owner, 999999)).toThrow('Sale 999999 not found')
  })

  it('throws PermissionError for a forged/invalid role, proving assertPermission is actually called', () => {
    const sale = createSale(db, owner, baseInput())
    db.prepare('UPDATE sales SET whatsapp_customer_sent = 1, whatsapp_owner_sent = 1 WHERE id = ?').run(sale.id)
    const forged = { ...owner, role: 'accountant' } as unknown as SafeUser
    expect(() => markSalePrinted(db, forged, sale.id)).toThrow(PermissionError)
  })
})

describe('usePrintOverride (PHASE6.md section 3 — Owner-only "print anyway")', () => {
  it('sets print_override_used and logs who used it plus which flags were still false at the time', () => {
    const sale = createSale(db, owner, baseInput())
    db.prepare('UPDATE sales SET whatsapp_owner_sent = 1 WHERE id = ?').run(sale.id)

    const overridden = usePrintOverride(db, owner, sale.id)
    expect(overridden.print_override_used).toBe(1)
    expect(overridden.print_override_by_user_id).toBe(ownerId)
    expect(overridden.print_override_customer_sent_at_use).toBe(0)
    expect(overridden.print_override_owner_sent_at_use).toBe(1)
    expect(overridden.print_override_at).not.toBeNull()
  })

  it('rejects a Salesman session outright — a Salesman must never be able to trigger print_override_used, even via a direct backend call (PHASE6.md section 3)', () => {
    const sale = createSale(db, salesman, baseInput())
    expect(() => usePrintOverride(db, salesman, sale.id)).toThrow(PermissionError)
    expect(getSaleById(db, sale.id)!.print_override_used).toBe(0)
  })

  it('throws for a nonexistent sale id', () => {
    expect(() => usePrintOverride(db, owner, 999999)).toThrow('Sale 999999 not found')
  })
})

describe('createSale — salesman typed on the sale screen', () => {
  const salesmanNames = () =>
    (db.prepare('SELECT name FROM salesmen ORDER BY id').all() as { name: string }[]).map((row) => row.name)

  it('adds a name that is new and records the sale under it — even for the counter session', () => {
    const sale = createSale(db, salesman, baseInput({ salesmanName: '  Ramesh  ' }))

    expect(salesmanNames()).toEqual(['Ramesh'])
    const stored = db
      .prepare('SELECT sm.name AS name FROM sales s JOIN salesmen sm ON sm.id = s.salesman_id WHERE s.id = ?')
      .get(sale.id) as { name: string }
    expect(stored.name).toBe('Ramesh')
  })

  it('reuses an existing salesman case-insensitively rather than adding a second one', () => {
    const first = createSale(db, salesman, baseInput({ salesmanName: 'Ramesh' }))
    const second = createSale(db, salesman, baseInput({ salesmanName: 'ramesh' }))

    expect(salesmanNames()).toEqual(['Ramesh'])
    expect(second.salesman_id).toBe(first.salesman_id)
  })

  it('treats a blank name as Unassigned and adds nobody', () => {
    const sale = createSale(db, salesman, baseInput({ salesmanName: '   ' }))

    expect(sale.salesman_id).toBeNull()
    expect(salesmanNames()).toEqual([])
  })

  it('refuses a name the Owner has switched off, instead of quietly switching them back on', () => {
    db.prepare("INSERT INTO salesmen (name, is_active) VALUES ('Suresh', 0)").run()

    expect(() => createSale(db, salesman, baseInput({ salesmanName: 'suresh' }))).toThrow(/switched off/)

    expect((db.prepare("SELECT is_active FROM salesmen WHERE name = 'Suresh'").get() as { is_active: number }).is_active).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(0)
  })

  it('refuses an over-long name before writing anything', () => {
    expect(() => createSale(db, salesman, baseInput({ salesmanName: 'x'.repeat(61) }))).toThrow(/60 characters/)
    expect(salesmanNames()).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(0)
  })

  it('does not leave a new salesman behind when the sale itself is rejected', () => {
    expect(() =>
      createSale(db, salesman, baseInput({ salesmanName: 'Ramesh', cashAmount: 1 })),
    ).toThrow()
    expect(salesmanNames()).toEqual([])
  })
})
