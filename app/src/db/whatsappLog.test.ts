// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSale } from './sales.ts'
import { createParty } from './parties.ts'
import {
  countSalesAwaitingWhatsApp,
  getCustomerBillDeliveries,
  getSalesAwaitingWhatsApp,
  logWhatsAppAttempt,
  markWhatsAppSent,
  setWhatsAppMessageId,
  updateWhatsAppAckByMessageId,
  updateWhatsAppLogStatus,
} from './whatsappLog.ts'
import type { SafeUser } from '../types/user.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let owner: SafeUser
let saleId: number

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

  const ownerId = db
    .prepare(`INSERT INTO users (username, password_hash, role, full_name) VALUES ('owner', 'x', 'owner', 'Shop Owner')`)
    .run().lastInsertRowid as number
  owner = { id: ownerId, username: 'owner', role: 'owner', full_name: 'Shop Owner' }

  const sale = createSale(db, owner, {
    partyId: null,
    items: [{ itemName: 'Cotton Saree', quantity: 1, unitPrice: 500 }],
    discount: 0,
    paymentMode: 'cash',
    cashAmount: 500,
    upiAmount: 0,
    creditAmount: 0,
  })
  saleId = sale.id
})

describe('logWhatsAppAttempt / updateWhatsAppLogStatus', () => {
  it('inserts a pending row and can resolve it to sent', () => {
    const logId = logWhatsAppAttempt(db, saleId, 'owner', '919999999999', 'pending')
    let row = db.prepare('SELECT * FROM whatsapp_log WHERE id = ?').get(logId) as { status: string }
    expect(row.status).toBe('pending')

    updateWhatsAppLogStatus(db, logId, 'sent')
    row = db.prepare('SELECT * FROM whatsapp_log WHERE id = ?').get(logId) as { status: string }
    expect(row.status).toBe('sent')
  })

  it('resolves to failed without touching the sale flag', () => {
    const logId = logWhatsAppAttempt(db, saleId, 'customer', '9876500002', 'pending')
    updateWhatsAppLogStatus(db, logId, 'failed')

    const sale = db.prepare('SELECT whatsapp_customer_sent FROM sales WHERE id = ?').get(saleId) as {
      whatsapp_customer_sent: number
    }
    expect(sale.whatsapp_customer_sent).toBe(0)
  })

  it('records a null recipient_number cleanly (schema allows it)', () => {
    const logId = logWhatsAppAttempt(db, saleId, 'customer', null, 'failed')
    const row = db.prepare('SELECT recipient_number FROM whatsapp_log WHERE id = ?').get(logId) as {
      recipient_number: string | null
    }
    expect(row.recipient_number).toBeNull()
  })
})

describe('markWhatsAppSent', () => {
  it('sets only the targeted recipient flag, leaving the other false', () => {
    markWhatsAppSent(db, saleId, 'owner')

    const sale = db
      .prepare('SELECT whatsapp_customer_sent, whatsapp_owner_sent FROM sales WHERE id = ?')
      .get(saleId) as { whatsapp_customer_sent: number; whatsapp_owner_sent: number }
    expect(sale.whatsapp_owner_sent).toBe(1)
    expect(sale.whatsapp_customer_sent).toBe(0)
  })

  it('is idempotent when called twice for the same recipient', () => {
    markWhatsAppSent(db, saleId, 'customer')
    markWhatsAppSent(db, saleId, 'customer')

    const sale = db.prepare('SELECT whatsapp_customer_sent FROM sales WHERE id = ?').get(saleId) as {
      whatsapp_customer_sent: number
    }
    expect(sale.whatsapp_customer_sent).toBe(1)
  })
})

describe('setWhatsAppMessageId / updateWhatsAppAckByMessageId', () => {
  it('records the wa message id and initial ack, then applies a later ack update by message id', () => {
    const logId = logWhatsAppAttempt(db, saleId, 'customer', '919876500002', 'sent')
    setWhatsAppMessageId(db, logId, 'true_919876500002@c.us_ABC123', 1)

    let row = db.prepare('SELECT wa_message_id, ack FROM whatsapp_log WHERE id = ?').get(logId) as {
      wa_message_id: string
      ack: number
    }
    expect(row).toEqual({ wa_message_id: 'true_919876500002@c.us_ABC123', ack: 1 })

    const changedId = updateWhatsAppAckByMessageId(db, 'true_919876500002@c.us_ABC123', 3)
    expect(changedId).toBe(logId)

    row = db.prepare('SELECT wa_message_id, ack FROM whatsapp_log WHERE id = ?').get(logId) as {
      wa_message_id: string
      ack: number
    }
    expect(row.ack).toBe(3)
  })

  it('returns null for an ack update that matches no logged message', () => {
    expect(updateWhatsAppAckByMessageId(db, 'no_such_message_id', 3)).toBeNull()
  })
})

describe('getCustomerBillDeliveries', () => {
  it('returns only customer-recipient rows, newest first, joined with the party name and sale total', () => {
    const owner2 = owner
    const party = createParty(db, owner2, { name: 'Sunita Fabrics', phone: '9876500002' })

    logWhatsAppAttempt(db, saleId, 'owner', '919999999999', 'sent') // must not appear below
    const customerLogId = logWhatsAppAttempt(db, saleId, 'customer', '919876500002', 'sent')
    setWhatsAppMessageId(db, customerLogId, 'true_919876500002@c.us_XYZ', 2)

    const secondSale = createSale(db, owner2, {
      partyId: party.id,
      items: [{ itemName: 'Silk Saree', quantity: 1, unitPrice: 1200 }],
      discount: 0,
      paymentMode: 'cash',
      cashAmount: 1200,
      upiAmount: 0,
      creditAmount: 0,
    })
    const secondLogId = logWhatsAppAttempt(db, secondSale.id, 'customer', '919876500002', 'sent')
    setWhatsAppMessageId(db, secondLogId, 'true_919876500002@c.us_NEWEST', 3)

    const deliveries = getCustomerBillDeliveries(db)

    expect(deliveries.every((d) => d.recipientNumber === '919876500002')).toBe(true)
    expect(deliveries.map((d) => d.saleId)).toEqual([secondSale.id, saleId])
    expect(deliveries[0]).toMatchObject({ partyName: 'Sunita Fabrics', ack: 3, status: 'sent', grandTotal: 1200 })
    expect(deliveries[1]).toMatchObject({ partyName: null, ack: 2 })
  })

  it('excludes rows with no recipient number', () => {
    logWhatsAppAttempt(db, saleId, 'customer', null, 'failed')
    expect(getCustomerBillDeliveries(db)).toEqual([])
  })
})

/**
 * These pin the promise that replaced the print gate. Printing no longer waits
 * for WhatsApp, so "the bill still reaches the Owner and the customer" now
 * rests entirely on this queue being right: anything it wrongly omits is a
 * bill that silently never sends and never shows up in the count either.
 */
describe('getSalesAwaitingWhatsApp / countSalesAwaitingWhatsApp', () => {
  function saleFor(partyId: number | null): number {
    return createSale(db, owner, {
      partyId,
      items: [{ itemName: 'Cotton Saree', quantity: 1, unitPrice: 500 }],
      discount: 0,
      paymentMode: 'cash',
      cashAmount: 500,
      upiAmount: 0,
      creditAmount: 0,
    }).id
  }

  it('lists a sale with neither copy sent', () => {
    expect(getSalesAwaitingWhatsApp(db)).toContain(saleId)
    expect(countSalesAwaitingWhatsApp(db)).toBe(1)
  })

  it('still lists a sale whose Owner copy landed but whose customer copy has not', () => {
    const party = createParty(db, owner, { name: 'Sunita Fabrics', phone: '9876500002', address: null, openingBalance: 0 })
    const id = saleFor(party.id)
    markWhatsAppSent(db, id, 'owner')

    expect(getSalesAwaitingWhatsApp(db)).toContain(id)
  })

  it('drops a sale once both copies have gone', () => {
    const party = createParty(db, owner, { name: 'Sunita Fabrics', phone: '9876500002', address: null, openingBalance: 0 })
    const id = saleFor(party.id)
    markWhatsAppSent(db, id, 'owner')
    markWhatsAppSent(db, id, 'customer')

    expect(getSalesAwaitingWhatsApp(db)).not.toContain(id)
  })

  // A walk-in cash sale has nobody to send a customer copy to. Counting it as
  // undelivered would leave the badge permanently non-zero, and a count that is
  // always on is a count nobody reads.
  it('does not wait on a customer copy for a sale with no phone number on file', () => {
    const id = saleFor(null)
    markWhatsAppSent(db, id, 'owner')

    expect(getSalesAwaitingWhatsApp(db)).not.toContain(id)
  })

  it('treats a party with a blank phone the same as one with none', () => {
    const party = createParty(db, owner, { name: 'No Phone', phone: '   ', address: null, openingBalance: 0 })
    const id = saleFor(party.id)
    markWhatsAppSent(db, id, 'owner')

    expect(getSalesAwaitingWhatsApp(db)).not.toContain(id)
  })

  // The escape valve. A bill to a wrong number can never succeed, so without
  // this it would retry on every reconnect forever and hold the count above
  // zero forever.
  it('drops a sale the Owner has explicitly stopped retrying, even with both copies unsent', () => {
    const id = saleFor(null)
    db.prepare('UPDATE sales SET print_override_used = 1 WHERE id = ?').run(id)

    expect(getSalesAwaitingWhatsApp(db)).not.toContain(id)
  })

  it('returns oldest first, so a reconnect clears the backlog in the order it built up', () => {
    const second = saleFor(null)
    const third = saleFor(null)

    expect(getSalesAwaitingWhatsApp(db)).toEqual([saleId, second, third])
  })
})
