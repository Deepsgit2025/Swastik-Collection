import type Database from 'better-sqlite3'
import type { SaleRecord } from '../../src/types/sale.js'
import { buildBillCaption, buildBillImageHtml } from '../../src/lib/billImage.js'
import {
  getSalesAwaitingWhatsApp,
  logWhatsAppAttempt,
  markWhatsAppSent,
  setWhatsAppMessageId,
  updateWhatsAppLogStatus,
  type WhatsAppRecipientType,
} from '../../src/db/whatsappLog.js'
import { getSaleById } from '../../src/db/sales.js'
import { getPartyById } from '../../src/db/parties.js'
import { sendBillViaAgent } from '../agent/client.js'
import { renderBillImagePng } from './billImage.js'
import { getShopSettings } from '../../src/db/settings.js'
import { toWhatsAppNumber } from '../../src/lib/phone.js'

/**
 * Logs a `pending` row, attempts the send, then resolves the row to
 * `sent`/`failed` and — only on success — flips the sale's sent flag
 * (PHASE6.md section 3). Failures are swallowed here by design: a failed
 * send just leaves the flag false, which is what `retryPendingBills` picks up
 * on the next reconnect; there's nothing further for this function to do
 * about it. (Until 2026-08-24 that false flag also held the print gate shut —
 * it no longer does, so an outage costs a delay rather than a stalled
 * counter. See `assertSalePrintable` in src/db/sales.ts.)
 *
 * Ordering matters and is deliberate. `sendWhatsAppMessage` only resolves
 * once the send is *confirmed* (it verifies against the chat rather than
 * trusting whatsapp-web.js's return value — see client.ts), so the moment it
 * resolves, "this bill reached this recipient" is a settled fact. Both
 * durable records of that fact are therefore written first, and the
 * optional delivery-tick bookkeeping is guarded separately afterwards.
 *
 * The previous version recorded the message id *between* those two writes,
 * inside the same try: when that id turned out to be missing — routine for
 * media sends — the resulting TypeError was caught below and flipped the row
 * back to `failed`, skipping `markWhatsAppSent` entirely. Customers were
 * getting their bill while the app reported "Not delivered" and kept the
 * print gate shut. Nothing about recording a tick is allowed to demote a
 * send that actually happened.
 *
 * A failure keeps *why* on the row (`whatsapp_log.error`) rather than only
 * in a main-process console line the Owner will never see — "Not delivered"
 * on its own gave them nothing to act on, and no way to tell a mistyped
 * phone number apart from a session that had quietly dropped.
 */
async function attemptSend(
  db: Database.Database,
  saleId: number,
  recipientType: WhatsAppRecipientType,
  number: string,
  bill: { base64Png: string; filename: string; caption: string },
): Promise<void> {
  const logId = logWhatsAppAttempt(db, saleId, recipientType, number, 'pending')
  try {
    // Sent by the agent process, which holds the live WhatsApp session — see
    // agent/protocol.ts. The failure text it returns is the real WhatsApp one,
    // preserved across the hop so it still lands in `whatsapp_log.error`.
    const result = await sendBillViaAgent({ number, ...bill })

    updateWhatsAppLogStatus(db, logId, 'sent')
    markWhatsAppSent(db, saleId, recipientType)

    // Best-effort only: without an id we simply can't match later
    // `message_ack` events to this row, so it renders as a single grey tick
    // ("sent, delivery unknown") instead of showing real ticks.
    if (result.waMessageId) {
      try {
        setWhatsAppMessageId(db, logId, result.waMessageId, result.ack ?? 0)
      } catch (err) {
        console.error(`[whatsapp] could not record the message id for sale ${saleId} (${recipientType}):`, err)
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[whatsapp] send to ${recipientType} (sale ${saleId}) failed:`, err)
    updateWhatsAppLogStatus(db, logId, 'failed', reason)
  }
}

/**
 * Triggered automatically right after `createSale` succeeds (PHASE6.md
 * section 3) — no manual "send" button for the normal path. The Owner's
 * number, the shop name and the shop phone all come from the `settings` table
 * (`getShopSettings`), read fresh on every call so an edit in Settings takes
 * effect on the very next sale with nothing to restart or invalidate. Until
 * Phase 12 these were the `TEMP_*` constants in `./config.ts`, which is now
 * deleted. The customer
 * send only fires when a phone number is actually on file; when it isn't, no
 * attempt is logged and `whatsapp_customer_sent` is simply left false here —
 * cleanly resolving that into "not applicable" rather than "a failed attempt"
 * is section 4's job (the next pass, along with the visibly distinct UI
 * states and the Owner override), not this one.
 *
 * **Recipients already marked sent on the sale are skipped**, which makes
 * this safe to call a second time on the same sale. That's what the Owner's
 * "Send again" button on a failed bill-delivery row does: a sale whose
 * customer send failed while the Owner copy went through re-sends only to
 * the customer, so retrying can't put a duplicate bill in anyone's chat. For
 * a freshly created sale both flags are false, so the normal path is
 * unaffected.
 */
export async function sendSaleWhatsAppNotifications(
  db: Database.Database,
  sale: SaleRecord,
  partyName: string | null,
  customerPhone: string | null,
): Promise<void> {
  // Numbers are normalized to whatsapp-web.js's required digits-only,
  // country-code-first form here (src/lib/phone.ts) — parties.phone is
  // stored and displayed as a plain 10-digit Indian mobile number (nobody
  // types a country code at the counter), so without this the customer send
  // silently fails to resolve a chat id while the Owner send (already
  // hardcoded with a country code) works, which is exactly the bug this
  // fixes: the bill reached the Owner but never the customer.
  const shop = getShopSettings(db)

  const recipients: Array<{ type: WhatsAppRecipientType; number: string }> = []
  if (!sale.whatsapp_owner_sent) {
    // Only reachable by hand-editing the database — `setShopSettings` refuses
    // to save this blank, precisely because `getSalesAwaitingWhatsApp` counts
    // any sale with `whatsapp_owner_sent = 0` as still owed and there is no
    // "no Owner number on file" case the way there is for a walk-in customer.
    // Recorded as a failed row with the reason rather than sent to '': every
    // WhatsApp bug in this project was diagnosed from a `whatsapp_log` read,
    // and the one failure that left nothing behind cost two passes to find.
    if (!shop.ownerWhatsappNumber.trim()) {
      console.error(`[whatsapp] no Owner WhatsApp number is set — sale ${sale.id} has nowhere to send the Owner copy`)
      const logId = logWhatsAppAttempt(db, sale.id, 'owner', null, 'pending')
      updateWhatsAppLogStatus(db, logId, 'failed', "No Owner WhatsApp number is set — add one in Settings.")
    } else {
      recipients.push({ type: 'owner', number: toWhatsAppNumber(shop.ownerWhatsappNumber) })
    }
  }
  if (customerPhone && !sale.whatsapp_customer_sent) {
    recipients.push({ type: 'customer', number: toWhatsAppNumber(customerPhone) })
  }
  // Nothing left to send — a resend on a sale that has since fully gone out.
  // Returning before rendering the bill image keeps that a genuine no-op.
  if (recipients.length === 0) return

  // Rendered once — identical for both recipients — rather than per send.
  // If rendering itself fails (before any WhatsApp send is even attempted),
  // log a failed row per intended recipient instead of throwing: createSale
  // has already succeeded by the time this runs, so a render failure must
  // still leave a whatsapp_log trail and resolve cleanly, the same as a send
  // failure would, rather than rejecting the caller's sale:create handler.
  //
  // Rendering stays in this process because it uses a hidden Electron
  // BrowserWindow (billImage.ts); the agent gets the finished bytes.
  let bill: { base64Png: string; filename: string; caption: string }
  try {
    const html = buildBillImageHtml(sale, partyName, shop.shopName, shop.shopPhone)
    const png = await renderBillImagePng(html)
    bill = {
      base64Png: png.toString('base64'),
      filename: `bill-${sale.id}.png`,
      caption: buildBillCaption(sale, shop.shopName),
    }
  } catch (err) {
    const reason = `Could not draw the bill image: ${err instanceof Error ? err.message : String(err)}`
    console.error(`[whatsapp] rendering the bill image for sale ${sale.id} failed:`, err)
    for (const { type, number } of recipients) {
      const logId = logWhatsAppAttempt(db, sale.id, type, number, 'pending')
      updateWhatsAppLogStatus(db, logId, 'failed', reason)
    }
    return
  }

  await Promise.all(recipients.map(({ type, number }) => attemptSend(db, sale.id, type, number, bill)))
}

/**
 * Re-sends every bill whose WhatsApp copy is still outstanding. Called when
 * the session reports `connected`, so a bill rung up during an outage goes out
 * on its own the moment WhatsApp is back — no Owner action, no "Send again"
 * click per sale.
 *
 * This is what makes the print gate safe to have removed. Print no longer
 * waits on delivery (`assertSalePrintable`, src/db/sales.ts), so the promise
 * that replaces it — "the bill still reaches the Owner and the customer" —
 * rests entirely on this running reliably.
 *
 * Safety comes from `sendSaleWhatsAppNotifications` skipping recipients
 * already flagged sent: a sale whose Owner copy landed but whose customer copy
 * failed re-sends to the customer only, and a fully-sent sale is a no-op that
 * returns before the bill image is even rendered. So this cannot put a second
 * copy of anything in anyone's chat, however often it runs.
 *
 * Sequential, not `Promise.all`: a reconnect after a long outage can have a
 * backlog of bills, and firing them all at once at a session that has just
 * finished resyncing is the way to get rate-limited or to wedge it again. One
 * failure never stops the rest — each is logged and the loop continues.
 */
export async function retryPendingBills(db: Database.Database): Promise<void> {
  const saleIds = getSalesAwaitingWhatsApp(db)
  if (saleIds.length === 0) return

  console.log(`[whatsapp] ${saleIds.length} bill(s) still to send — retrying now that the session is back`)
  for (const saleId of saleIds) {
    const sale = getSaleById(db, saleId)
    // Deleted between the query and here — the retention purge is the only
    // thing that removes sales, and it has every right to have run.
    if (!sale) continue
    const party = sale.party_id != null ? getPartyById(db, sale.party_id) : null
    try {
      await sendSaleWhatsAppNotifications(db, sale, party?.name ?? null, party?.phone ?? null)
    } catch (err: unknown) {
      // `sendSaleWhatsAppNotifications` resolves on send failure by design, so
      // reaching here means something rarer went wrong. It must not take the
      // rest of the queue down with it.
      console.error(`[whatsapp] retry for sale ${saleId} failed outright:`, err)
    }
  }
}
