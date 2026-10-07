import type Database from 'better-sqlite3'
import type { BillDeliveryRow } from '../types/whatsapp.js'

export type WhatsAppRecipientType = 'customer' | 'owner'
export type WhatsAppLogStatus = 'pending' | 'sent' | 'failed'

/**
 * One row per send attempt (PHASE6.md section 3: "log every attempt in
 * whatsapp_log ... one row per recipient per sale, status pending -> sent/
 * failed"). No `assertPermission` call — this isn't a user-invoked action of
 * its own, it's a system side effect of `sale:create`, which already gates
 * itself; same pattern as `adjustPartyBalance` in parties.ts.
 */
export function logWhatsAppAttempt(
  db: Database.Database,
  saleId: number,
  recipientType: WhatsAppRecipientType,
  recipientNumber: string | null,
  status: WhatsAppLogStatus,
): number {
  const result = db
    .prepare('INSERT INTO whatsapp_log (sale_id, recipient_type, recipient_number, status) VALUES (?, ?, ?, ?)')
    .run(saleId, recipientType, recipientNumber, status)
  return result.lastInsertRowid as number
}

/**
 * Resolves a `pending` row. `error` is only meaningful for `failed` — it's
 * the reason the send didn't go through, in the sender's own words, so the
 * Owner sees *why* on the bill-delivery row rather than a bare "Not
 * delivered" (a wrong number, a dropped session and a WhatsApp Web internals
 * change all used to look identical). Passing nothing clears it, which is
 * what a `sent` resolution wants.
 */
export function updateWhatsAppLogStatus(
  db: Database.Database,
  logId: number,
  status: WhatsAppLogStatus,
  error: string | null = null,
): void {
  db.prepare('UPDATE whatsapp_log SET status = ?, error = ? WHERE id = ?').run(status, error, logId)
}

/**
 * Records whatsapp-web.js's own message id (Message.id._serialized) and its
 * initial ack level right after a successful send, so later `message_ack`
 * events — which only carry that id, not our logId — can be matched back to
 * this row. Called once, right after `sendWhatsAppMessage` resolves.
 */
export function setWhatsAppMessageId(db: Database.Database, logId: number, waMessageId: string, ack: number): void {
  db.prepare('UPDATE whatsapp_log SET wa_message_id = ?, ack = ? WHERE id = ?').run(waMessageId, ack, logId)
}

/**
 * Applied from the main process's `message_ack` listener (electron/whatsapp/client.ts)
 * as real WhatsApp delivery/read events arrive. Returns the affected row's id
 * (or null if no row matches, e.g. an ack for a message this log never sent)
 * so the caller knows whether to push a live UI update.
 */
export function updateWhatsAppAckByMessageId(db: Database.Database, waMessageId: string, ack: number): number | null {
  const result = db.prepare('UPDATE whatsapp_log SET ack = ? WHERE wa_message_id = ?').run(ack, waMessageId)
  if (result.changes === 0) return null
  const row = db.prepare('SELECT id FROM whatsapp_log WHERE wa_message_id = ?').get(waMessageId) as { id: number }
  return row.id
}

/**
 * Every customer-facing bill send, newest first — the sole data source for
 * the Owner-only bill-delivery view. Deliberately scoped to
 * `recipient_type = 'customer'` only (the Owner's own copy isn't "did the
 * bill reach the customer" information) and built entirely from this app's
 * own log/sales/parties tables rather than WhatsApp's real chat list, so the
 * view can never show a chat the shop didn't itself send a bill into.
 */
export function getCustomerBillDeliveries(db: Database.Database): BillDeliveryRow[] {
  const rows = db
    .prepare(
      `SELECT
         wl.id AS id,
         wl.sale_id AS saleId,
         wl.recipient_number AS recipientNumber,
         wl.status AS status,
         wl.error AS error,
         wl.wa_message_id AS waMessageId,
         wl.ack AS ack,
         wl.attempted_at AS attemptedAt,
         p.name AS partyName,
         s.grand_total AS grandTotal,
         s.created_at AS saleCreatedAt
       FROM whatsapp_log wl
       JOIN sales s ON s.id = wl.sale_id
       LEFT JOIN parties p ON p.id = s.party_id
       WHERE wl.recipient_type = 'customer' AND wl.recipient_number IS NOT NULL
       ORDER BY wl.attempted_at DESC, wl.id DESC`,
    )
    .all() as BillDeliveryRow[]
  return rows
}

const SENT_FLAG_COLUMN: Record<WhatsAppRecipientType, 'whatsapp_customer_sent' | 'whatsapp_owner_sent'> = {
  customer: 'whatsapp_customer_sent',
  owner: 'whatsapp_owner_sent',
}

/**
 * Flips the sale's per-recipient sent flag to true. Callers must only invoke
 * this on confirmed success (PHASE6.md section 3: "update ... only on
 * confirmed success") — there is no path here to set it back to false, since
 * a flag going true is meant to be a one-way, audited fact.
 */
export function markWhatsAppSent(db: Database.Database, saleId: number, recipientType: WhatsAppRecipientType): void {
  db.prepare(`UPDATE sales SET ${SENT_FLAG_COLUMN[recipientType]} = 1 WHERE id = ?`).run(saleId)
}

/**
 * Sales with a WhatsApp copy still outstanding, oldest first.
 *
 * Drives two things that replaced the old blocking print gate: the automatic
 * retry (`retryPendingBills`, electron/whatsapp/send.ts) that re-sends these
 * the moment the session reconnects, and the undelivered count beside the
 * status badge that keeps them visible while they wait.
 *
 * A row qualifies on the sale's own sent flags rather than on
 * `whatsapp_log.status`, because the flags are the durable fact — a log row
 * can be `failed` for a bill that actually landed (that exact mismatch is
 * documented at length on `attemptSend`), whereas the flag is only ever set
 * on confirmed success. The customer half additionally requires a phone
 * number to exist: a cash sale to a walk-in has no customer to send to, and
 * counting it as undelivered forever would make the badge meaningless.
 *
 * `print_override_used` takes a sale out of the queue for the same reason. A
 * bill to a wrong or unregistered number can never succeed, and without an
 * escape valve it would retry on every reconnect and inflate the count
 * forever — which trains the Owner to ignore the count, and the count is what
 * now stands in for the print gate that used to block. The override already
 * records who decided and when (migration 006), so the decision stays audited.
 */
export function getSalesAwaitingWhatsApp(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id
         FROM sales s
         LEFT JOIN parties p ON p.id = s.party_id
        WHERE s.print_override_used = 0
          AND (
                s.whatsapp_owner_sent = 0
             OR (s.whatsapp_customer_sent = 0 AND p.phone IS NOT NULL AND TRIM(p.phone) <> '')
              )
        ORDER BY s.id ASC`,
    )
    .all() as Array<{ id: number }>
  return rows.map((row) => row.id)
}

/** How many bills are still waiting to go out — the count rendered beside the WhatsApp status badge. */
export function countSalesAwaitingWhatsApp(db: Database.Database): number {
  return getSalesAwaitingWhatsApp(db).length
}
