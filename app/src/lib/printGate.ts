import type { SaleRecord } from '../types/sale.ts'

/**
 * Whether this bill's WhatsApp copies are known to have landed.
 *
 * **This no longer gates printing.** Until 2026-08-24 it did: the Print button
 * stayed disabled until both sends confirmed, enforced again server-side in
 * `assertSalePrintable`. That is what made a WhatsApp outage stop the counter.
 * A dropped session takes minutes to resync — WhatsApp re-delivers every
 * message that arrived while the linked device was away before it will send
 * anything — and for all of those minutes a customer stood at the counter
 * waiting for a bill that could not be printed, with an Owner override on
 * every single sale as the only way through.
 *
 * Delivery is now queued rather than waited on: `retryPendingBills`
 * (electron/whatsapp/send.ts) re-sends anything outstanding the moment the
 * session reconnects, with no one having to act. So this predicate survives
 * only to say *what to tell the operator* — it decides wording, not whether
 * the printer runs.
 *
 * What that gives up, deliberately and at the client's request: printing no
 * longer proves the Owner received their copy. The replacement is visibility —
 * the undelivered count beside the WhatsApp badge, and the Owner's
 * bill-delivery list — plus the automatic retry that makes an undelivered bill
 * a temporary state rather than a permanent one.
 */
export function isBillDeliveryConfirmed(
  sale: Pick<SaleRecord, 'whatsapp_customer_sent' | 'whatsapp_owner_sent' | 'print_override_used'>,
): boolean {
  return (Boolean(sale.whatsapp_customer_sent) && Boolean(sale.whatsapp_owner_sent)) || Boolean(sale.print_override_used)
}
