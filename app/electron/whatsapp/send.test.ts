// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSale, getSaleById } from '../../src/db/sales.ts'
import { createParty } from '../../src/db/parties.ts'
import type { SafeUser } from '../../src/types/user.ts'
import type { CreateSaleInput } from '../../src/types/sale.ts'

const sendBillViaAgent = vi.fn()
// The send itself now happens in the agent process (electron/agent), reached
// over loopback HTTP — mocked out here (same as every other write-path test in
// this codebase avoids touching real I/O) so this test exercises only the
// logging/flag orchestration in send.ts.
vi.mock('../agent/client.ts', () => ({ sendBillViaAgent }))

const renderBillImagePng = vi.fn()
// billImage.ts (Electron-only) needs a real BrowserWindow — mocked out here
// the same way, so this test never touches real rendering.
vi.mock('./billImage.ts', () => ({ renderBillImagePng }))

const { sendSaleWhatsAppNotifications, retryPendingBills } = await import('./send.ts')
const { getShopSettings, setShopSettings } = await import('../../src/db/settings.ts')

/**
 * The shop identity these tests assert against. Since Phase 12 it comes from
 * the `settings` table (seeded by migration 009 below), not from the deleted
 * `TEMP_*` constants in `./config.ts` — so these assertions now prove the send
 * path reads the Owner's real setting rather than a compile-time value.
 */
let ownerNumber: string
let businessName: string

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let owner: SafeUser

interface WhatsAppLogRow {
  sale_id: number
  recipient_type: 'customer' | 'owner'
  recipient_number: string | null
  status: 'pending' | 'sent' | 'failed'
}

function logRows(saleId: number): WhatsAppLogRow[] {
  return db
    .prepare('SELECT sale_id, recipient_type, recipient_number, status FROM whatsapp_log WHERE sale_id = ? ORDER BY id ASC')
    .all(saleId) as WhatsAppLogRow[]
}

function deliveryColumns(saleId: number): Array<{ wa_message_id: string | null; ack: number | null }> {
  return db
    .prepare('SELECT wa_message_id, ack FROM whatsapp_log WHERE sale_id = ? ORDER BY id ASC')
    .all(saleId) as Array<{ wa_message_id: string | null; ack: number | null }>
}

function errorColumns(saleId: number): Array<{ status: string; error: string | null }> {
  return db
    .prepare('SELECT status, error FROM whatsapp_log WHERE sale_id = ? ORDER BY id ASC')
    .all(saleId) as Array<{ status: string; error: string | null }>
}

/** A confirmed send that also handed back a usable message handle — `WhatsAppSendResult` from client.ts. */
const SENT_WITH_ID = { waMessageId: 'true_919876543210@c.us_FAKE', ack: 1 }

beforeEach(() => {
  sendBillViaAgent.mockReset()
  renderBillImagePng.mockReset()
  renderBillImagePng.mockResolvedValue(Buffer.from('fake-png'))

  db = new Database(':memory:')
  // Every migration, in order, rather than the hand-picked subset this file
  // named until 2026-08-27. A named list breaks whenever a query grows a
  // dependency it does not know about — as it did when `createSale` started
  // writing `sales.salesman_id` — which is a maintenance cost with no matching
  // benefit. Same approach `reports.test.ts` already documents.
  const migrationsDir = path.join(__dirname, '../../src/db/migrations')
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'))
  }

  const ownerId = db
    .prepare(`INSERT INTO users (username, password_hash, role, full_name) VALUES ('owner', 'x', 'owner', 'Shop Owner')`)
    .run().lastInsertRowid as number
  owner = { id: ownerId, username: 'owner', role: 'owner', full_name: 'Shop Owner' }

  // Seed valid shop settings so the WhatsApp send tests have a real Owner number
  // and business name to work with (migration 009 now seeds empty strings).
  setShopSettings(db, owner, {
    shopName: 'Test Shop',
    shopAddress: '',
    shopPhone: '9000000001',
    ownerWhatsappNumber: '9000000002',
  })

  const shop = getShopSettings(db)
  ownerNumber = shop.ownerWhatsappNumber
  businessName = shop.shopName
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

describe('sendSaleWhatsAppNotifications', () => {
  it('always attempts the Owner send, even with no customer phone, and marks the flag on success', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, null, null)

    // Owner number is normalized by toWhatsAppNumber at send time (91 + 10 digits)
    const normalizedOwnerNumber = '91' + ownerNumber

    expect(sendBillViaAgent).toHaveBeenCalledTimes(1)
    expect(sendBillViaAgent).toHaveBeenCalledWith({
      number: normalizedOwnerNumber,
      base64Png: expect.any(String),
      filename: `bill-${sale.id}.png`,
      caption: expect.stringContaining(businessName),
    })

    const rows = logRows(sale.id)
    expect(rows).toEqual([
      { sale_id: sale.id, recipient_type: 'owner', recipient_number: normalizedOwnerNumber, status: 'sent' },
    ])

    const updated = getSaleById(db, sale.id)!
    expect(updated.whatsapp_owner_sent).toBe(1)
    expect(updated.whatsapp_customer_sent).toBe(0)
  })

  it('also attempts the customer send when a phone number is provided, and logs/marks both independently', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, 'Sunita Fabrics', '9876500002') // bare 10-digit number, as typed/stored

    expect(sendBillViaAgent).toHaveBeenCalledTimes(2)
    // '9876500002' is normalized to '919876500002' (src/lib/phone.ts) before
    // being handed to whatsapp-web.js — bare 10-digit party numbers otherwise
    // fail to resolve a chat id, which was the bug this normalization fixes.
    expect(sendBillViaAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        number: '919876500002',
        caption: expect.stringContaining(businessName),
      }),
    )
    // Rendered once and reused for both recipients, not re-rendered per send.
    expect(renderBillImagePng).toHaveBeenCalledTimes(1)

    const rows = logRows(sale.id)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.recipient_type === 'customer')).toMatchObject({
      recipient_number: '919876500002',
      status: 'sent',
    })
    expect(rows.find((r) => r.recipient_type === 'owner')).toMatchObject({ status: 'sent' })

    const updated = getSaleById(db, sale.id)!
    expect(updated.whatsapp_customer_sent).toBe(1)
    expect(updated.whatsapp_owner_sent).toBe(1)
  })

  it('logs a failed row and leaves the flag false when a send rejects, without throwing', async () => {
    sendBillViaAgent.mockRejectedValue(new Error('WhatsApp session is not connected'))
    const sale = createSale(db, owner, baseInput())

    await expect(sendSaleWhatsAppNotifications(db, sale, null, null)).resolves.toBeUndefined()

    const normalizedOwnerNumber = '91' + ownerNumber
    const rows = logRows(sale.id)
    expect(rows).toEqual([
      { sale_id: sale.id, recipient_type: 'owner', recipient_number: normalizedOwnerNumber, status: 'failed' },
    ])

    const updated = getSaleById(db, sale.id)!
    expect(updated.whatsapp_owner_sent).toBe(0)
  })

  it('does not attempt or log a customer send when no phone number is on file (cash sale)', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, null, null)

    expect(sendBillViaAgent).not.toHaveBeenCalledWith(expect.objectContaining({ number: null }))
    expect(logRows(sale.id).some((r) => r.recipient_type === 'customer')).toBe(false)
  })

  it('logs a failed row per intended recipient and resolves cleanly, without throwing, when rendering the bill image itself fails', async () => {
    renderBillImagePng.mockRejectedValue(new Error('capturePage failed'))
    const sale = createSale(db, owner, baseInput())

    await expect(sendSaleWhatsAppNotifications(db, sale, 'Sunita Fabrics', '9876500002')).resolves.toBeUndefined()

    expect(sendBillViaAgent).not.toHaveBeenCalled()
    const rows = logRows(sale.id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'failed')).toBe(true)
    expect(errorColumns(sale.id).every((r) => r.error === 'Could not draw the bill image: capturePage failed')).toBe(
      true,
    )

    const updated = getSaleById(db, sale.id)!
    expect(updated.whatsapp_owner_sent).toBe(0)
    expect(updated.whatsapp_customer_sent).toBe(0)
  })

  it('handles the two recipients independently — one succeeding does not affect the other failing', async () => {
    const normalizedOwnerNumber = '91' + ownerNumber
    sendBillViaAgent.mockImplementation(async ({ number }: { number: string }) => {
      if (number === normalizedOwnerNumber) throw new Error('owner send failed')
      return SENT_WITH_ID
    })
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, 'Sunita Fabrics', '9876500002') // bare 10-digit number, as typed/stored

    const updated = getSaleById(db, sale.id)!
    expect(updated.whatsapp_owner_sent).toBe(0)
    expect(updated.whatsapp_customer_sent).toBe(1)

    const rows = logRows(sale.id)
    expect(rows.find((r) => r.recipient_type === 'owner')?.status).toBe('failed')
    expect(rows.find((r) => r.recipient_type === 'customer')?.status).toBe('sent')
  })

  it('records the message id and ack on a send that returned a usable handle', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, null, null)

    expect(deliveryColumns(sale.id)).toEqual([{ wa_message_id: SENT_WITH_ID.waMessageId, ack: SENT_WITH_ID.ack }])
  })

  // Regression: the customer was getting their bill on WhatsApp while the app
  // showed "Not delivered / Failed to send" and kept the print gate shut.
  // whatsapp-web.js confirms the send but routinely hands back no message
  // handle for media sends (Client.sendMessage resolves `undefined` when its
  // post-send `Msg.get()` lookup misses a re-keyed message), and the old code
  // dereferenced that handle between marking the row 'sent' and setting the
  // sale flag — so the resulting TypeError flipped a delivered bill back to
  // 'failed'. A missing handle costs us delivery ticks, nothing more.
  it('treats a confirmed send with no message handle as sent, not failed', async () => {
    sendBillViaAgent.mockResolvedValue({ waMessageId: null, ack: null })
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, 'Sunita Fabrics', '9876500002')

    const rows = logRows(sale.id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'sent')).toBe(true)

    const updated = getSaleById(db, sale.id)!
    expect(updated.whatsapp_customer_sent).toBe(1)
    expect(updated.whatsapp_owner_sent).toBe(1)

    // No handle to match acks against — the row stays untracked and renders
    // as a single grey "sent" tick rather than a delivery state we never saw.
    expect(deliveryColumns(sale.id).every((r) => r.wa_message_id === null)).toBe(true)
  })

  // Same class of bug, one layer down: recording the tick metadata is
  // best-effort and must never be able to undo a send that actually happened.
  it('keeps a successful send marked sent even if recording its message id blows up', async () => {
    // An object is not a bindable SQLite value, so setWhatsAppMessageId throws
    // — standing in for any failure in that optional bookkeeping step.
    sendBillViaAgent.mockResolvedValue({ waMessageId: { nope: true }, ack: 1 })
    const sale = createSale(db, owner, baseInput())

    await expect(sendSaleWhatsAppNotifications(db, sale, null, null)).resolves.toBeUndefined()

    expect(logRows(sale.id)[0].status).toBe('sent')
    expect(getSaleById(db, sale.id)!.whatsapp_owner_sent).toBe(1)
  })

  // "Failed to send" on its own left the Owner nothing to act on — a mistyped
  // number, a session that had dropped and a WhatsApp Web internals change all
  // rendered identically. The sender's own words are kept on the row and shown
  // under it in the bill-delivery view.
  it('records why a send failed, not just that it failed', async () => {
    sendBillViaAgent.mockRejectedValue(new Error('+919876500002 is not on WhatsApp — check the number.'))
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, 'Sunita Fabrics', '9876500002')

    const rows = errorColumns(sale.id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'failed')).toBe(true)
    expect(rows.every((r) => r.error === '+919876500002 is not on WhatsApp — check the number.')).toBe(true)
  })

  it('leaves no stale failure reason on a row that succeeded', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, null, null)

    expect(errorColumns(sale.id)).toEqual([{ status: 'sent', error: null }])
  })

  // What makes the Owner's "Send again" button safe to press: retrying a sale
  // whose Owner copy landed but whose customer copy failed must re-send to the
  // customer *only*, never put a second identical bill in the Owner's chat.
  it('skips a recipient whose copy already went through, so a retry cannot duplicate it', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    const created = createSale(db, owner, baseInput())
    db.prepare('UPDATE sales SET whatsapp_owner_sent = 1 WHERE id = ?').run(created.id)
    const sale = getSaleById(db, created.id)!

    await sendSaleWhatsAppNotifications(db, sale, 'Sunita Fabrics', '9876500002')

    expect(sendBillViaAgent).toHaveBeenCalledTimes(1)
    expect(sendBillViaAgent).toHaveBeenCalledWith(expect.objectContaining({ number: '919876500002' }))
    const rows = logRows(sale.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].recipient_type).toBe('customer')
    expect(getSaleById(db, sale.id)!.whatsapp_customer_sent).toBe(1)
  })

  it('does nothing at all when both copies have already gone out', async () => {
    const created = createSale(db, owner, baseInput())
    db.prepare('UPDATE sales SET whatsapp_owner_sent = 1, whatsapp_customer_sent = 1 WHERE id = ?').run(created.id)
    const sale = getSaleById(db, created.id)!

    await expect(sendSaleWhatsAppNotifications(db, sale, 'Sunita Fabrics', '9876500002')).resolves.toBeUndefined()

    expect(sendBillViaAgent).not.toHaveBeenCalled()
    // Returns before the bill image is even drawn — a genuine no-op, not a
    // silent send with nowhere to go.
    expect(renderBillImagePng).not.toHaveBeenCalled()
    expect(logRows(sale.id)).toHaveLength(0)
  })

  // PHASE12.md section 1 / acceptance criterion 1: the Owner's number and the
  // shop name are now settings, not constants. This is the case that proves it
  // — the same send path, run twice, follows the edit.
  it('sends to the number and under the shop name currently saved in Settings, not a compile-time value', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)

    setShopSettings(db, owner, {
      shopName: 'Renamed Collections',
      shopAddress: '',
      shopPhone: '9000000001',
      ownerWhatsappNumber: '9876511111', // bare 10-digit, as an Owner would type it
    })

    const sale = createSale(db, owner, baseInput())
    await sendSaleWhatsAppNotifications(db, sale, null, null)

    expect(sendBillViaAgent).toHaveBeenCalledWith({
      // Normalized by toWhatsAppNumber at send time, exactly like a customer's
      // stored 10-digit phone — the Owner never types a country code either.
      number: '919876511111',
      base64Png: expect.any(String),
      filename: `bill-${sale.id}.png`,
      caption: expect.stringContaining('Renamed Collections'),
    })
    expect(sendBillViaAgent).not.toHaveBeenCalledWith(expect.objectContaining({ number: ownerNumber }))
    expect(logRows(sale.id)).toEqual([
      { sale_id: sale.id, recipient_type: 'owner', recipient_number: '919876511111', status: 'sent' },
    ])
  })

  // Only reachable by hand-editing the DB — `setShopSettings` refuses to save a
  // blank Owner number precisely because the sale would otherwise sit in the
  // pending-bill queue forever with nothing explaining why.
  it('records a failed row with a reason, rather than sending to nowhere, when no Owner number is set', async () => {
    db.prepare("UPDATE settings SET value = '' WHERE key = 'owner_whatsapp_number'").run()
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, null, null)

    expect(sendBillViaAgent).not.toHaveBeenCalled()
    expect(logRows(sale.id)).toEqual([
      { sale_id: sale.id, recipient_type: 'owner', recipient_number: null, status: 'failed' },
    ])
    expect(errorColumns(sale.id)[0].error).toContain('No Owner WhatsApp number is set')
    expect(getSaleById(db, sale.id)!.whatsapp_owner_sent).toBe(0)
  })

  // A blank Owner number must not take the customer's copy down with it — the
  // customer is the one person who was definitely promised a bill.
  it('still sends the customer copy when the Owner number is missing', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    db.prepare("UPDATE settings SET value = '' WHERE key = 'owner_whatsapp_number'").run()
    const sale = createSale(db, owner, baseInput())

    await sendSaleWhatsAppNotifications(db, sale, 'Sunita Fabrics', '9876500002')

    expect(sendBillViaAgent).toHaveBeenCalledTimes(1)
    expect(sendBillViaAgent).toHaveBeenCalledWith(expect.objectContaining({ number: '919876500002' }))
    expect(getSaleById(db, sale.id)!.whatsapp_customer_sent).toBe(1)
  })
})

/**
 * The guarantee that replaced the print gate.
 *
 * Print no longer waits for WhatsApp to confirm, so "the bill still gets
 * there" is now this function's job alone. If it silently skipped a sale, or
 * sent a second copy of one that had already gone, nothing else in the app
 * would catch it.
 */
describe('retryPendingBills', () => {
  it('sends a bill that never went out, and marks it once it lands', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    const sale = createSale(db, owner, baseInput())

    await retryPendingBills(db)

    expect(sendBillViaAgent).toHaveBeenCalledTimes(1)
    expect(getSaleById(db, sale.id)!.whatsapp_owner_sent).toBe(1)
  })

  // What makes this safe to run on every single reconnect.
  it('never re-sends a copy that already landed', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    const party = createParty(db, owner, {
      name: 'Sunita Fabrics',
      phone: '9876500002',
      address: null,
      openingBalance: 0,
    })
    const sale = createSale(db, owner, baseInput({ partyId: party.id }))
    db.prepare('UPDATE sales SET whatsapp_owner_sent = 1 WHERE id = ?').run(sale.id)

    await retryPendingBills(db)

    expect(sendBillViaAgent).toHaveBeenCalledTimes(1)
    expect(sendBillViaAgent).toHaveBeenCalledWith(expect.objectContaining({ number: '919876500002' }))
  })

  it('does nothing at all when every bill has gone out', async () => {
    const sale = createSale(db, owner, baseInput())
    db.prepare('UPDATE sales SET whatsapp_owner_sent = 1, whatsapp_customer_sent = 1 WHERE id = ?').run(sale.id)

    await retryPendingBills(db)

    expect(sendBillViaAgent).not.toHaveBeenCalled()
    expect(renderBillImagePng).not.toHaveBeenCalled()
  })

  // A backlog is exactly when one bad number is most likely to be in the
  // queue, and it must not strand every bill behind it.
  it('keeps going after one bill fails, so a single bad number cannot block the backlog', async () => {
    const first = createSale(db, owner, baseInput())
    const second = createSale(db, owner, baseInput())
    let call = 0
    sendBillViaAgent.mockImplementation(async () => {
      call += 1
      if (call === 1) throw new Error('not on WhatsApp')
      return SENT_WITH_ID
    })

    await retryPendingBills(db)

    expect(sendBillViaAgent).toHaveBeenCalledTimes(2)
    expect(getSaleById(db, first.id)!.whatsapp_owner_sent).toBe(0)
    expect(getSaleById(db, second.id)!.whatsapp_owner_sent).toBe(1)
  })

  it('leaves a bill the Owner stopped retrying alone', async () => {
    sendBillViaAgent.mockResolvedValue(SENT_WITH_ID)
    const sale = createSale(db, owner, baseInput())
    db.prepare('UPDATE sales SET print_override_used = 1 WHERE id = ?').run(sale.id)

    await retryPendingBills(db)

    expect(sendBillViaAgent).not.toHaveBeenCalled()
  })
})
