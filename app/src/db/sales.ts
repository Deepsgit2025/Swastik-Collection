import type Database from 'better-sqlite3'
import type { CreateSaleInput, SaleItemRecord, SaleRecord } from '../types/sale.ts'
import type { SafeUser } from '../types/user.ts'
import { assertPermission } from './permissions.ts'
import { adjustPartyBalance, getPartyById } from './parties.ts'
import { resolveSalesmanForSale, salesmanExists, validateSalesmanName } from './salesmen.ts'
import { RETENTION_TOTAL_DAYS } from '../lib/retention.ts'
import { computeSaleTotals, lineTotal, roundMoney, validateDiscount, validateLine, validateSplitTotal } from '../lib/saleMath.ts'

const SALE_COLUMNS = `id, party_id, salesman_user_id, salesman_id, payment_mode, cash_amount, upi_amount, credit_amount, subtotal, total_discount, grand_total, whatsapp_customer_sent, whatsapp_owner_sent, printed, print_override_used, print_override_by_user_id, print_override_customer_sent_at_use, print_override_owner_sent_at_use, print_override_at, is_cash_bill, archived_local, purge_at, created_at`

function getSaleItems(db: Database.Database, saleId: number): SaleItemRecord[] {
  return db
    .prepare('SELECT id, sale_id, item_name, barcode, quantity, unit_price, line_total FROM sale_items WHERE sale_id = ? ORDER BY id ASC')
    .all(saleId) as SaleItemRecord[]
}

/** Full sale record including its line items — returned by `createSale` and reused by Phase 6 for WhatsApp bill content. */
export function getSaleById(db: Database.Database, id: number): SaleRecord | null {
  const sale = db.prepare(`SELECT ${SALE_COLUMNS} FROM sales WHERE id = ?`).get(id) as
    | Omit<SaleRecord, 'items'>
    | undefined
  if (!sale) return null
  return { ...sale, items: getSaleItems(db, id) }
}

/**
 * Creates a sale plus its line items (PHASE5.md section 2, discount model
 * updated post-Phase-5 — see CLAUDE.md). Every money total is recomputed
 * here from the raw `quantity`/`unitPrice` on each item plus the single
 * bill-level `discount`; nothing pre-computed is accepted from the caller,
 * per section 3's "validate client-side and again in createSale server-side,
 * don't trust the UI alone." `computeSaleTotals`/`validateLine`/
 * `validateDiscount`/`validateSplitTotal` are the same functions the sale
 * screen uses for its own inline validation, so both layers enforce
 * identical rules — but this call is the one that actually gates the write,
 * since a modified renderer could skip its own client-side check.
 */
export function createSale(db: Database.Database, user: SafeUser, input: CreateSaleInput): SaleRecord {
  assertPermission(user.role, 'sale:create')

  if (!input.items || input.items.length === 0) {
    throw new Error('At least one item is required')
  }

  for (const item of input.items) {
    const error = validateLine({ itemName: item.itemName, quantity: item.quantity, unitPrice: item.unitPrice })
    if (error) throw new Error(error)
  }

  const lines = input.items.map((item) => ({ itemName: item.itemName, quantity: item.quantity, unitPrice: item.unitPrice }))
  const { subtotal } = computeSaleTotals(lines, 0)

  const discountError = validateDiscount(input.discount ?? 0, subtotal)
  if (discountError) throw new Error(discountError)

  const { totalDiscount, grandTotal } = computeSaleTotals(lines, input.discount ?? 0)

  const cashAmount = roundMoney(input.cashAmount ?? 0)
  const upiAmount = roundMoney(input.upiAmount ?? 0)
  const creditAmount = roundMoney(input.creditAmount ?? 0)

  const splitError = validateSplitTotal(cashAmount, upiAmount, creditAmount, grandTotal)
  if (splitError) throw new Error(splitError)

  if (creditAmount > 0 && input.partyId == null) {
    throw new Error('A party is required when any part of the payment is on credit')
  }

  if (input.partyId != null && !getPartyById(db, input.partyId)) {
    throw new Error(`Party ${input.partyId} not found`)
  }

  // Same guard `partyId` gets directly above, for the same reason: an id that
  // resolves to nothing would write a bill whose salesman silently disappears
  // from every report. Null is fine — an unassigned sale is a legal outcome
  // (see `CreateSaleInput.salesmanId`), an id pointing at nobody is not.
  const typedSalesmanName = (input.salesmanName ?? '').trim()
  if (typedSalesmanName === '' && input.salesmanId != null && !salesmanExists(db, input.salesmanId)) {
    throw new Error(`Salesman ${input.salesmanId} not found`)
  }
  // A typed name is checked for length now, so a bad one fails before anything
  // is written; resolving it (which may add a salesman) happens in the transaction.
  if (typedSalesmanName !== '') {
    const nameError = validateSalesmanName(typedSalesmanName)
    if (nameError) throw new Error(nameError)
  }

  // Only true when there's no credit component at all — a bill with any
  // credit is not a cash bill and follows the credit-bill retention rule instead
  // (kept until its party is settled — see src/db/retention.ts).
  const isCashBill = creditAmount === 0 ? 1 : 0

  const insertSale = db.prepare(
    `INSERT INTO sales (party_id, salesman_user_id, salesman_id, payment_mode, cash_amount, upi_amount, credit_amount, subtotal, total_discount, grand_total, is_cash_bill, purge_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${RETENTION_TOTAL_DAYS} days'))`,
  )
  const insertItem = db.prepare(
    `INSERT INTO sale_items (sale_id, item_name, barcode, quantity, unit_price, line_total)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  const run = db.transaction((): number => {
    const salesmanId = typedSalesmanName !== '' ? resolveSalesmanForSale(db, typedSalesmanName) : (input.salesmanId ?? null)
    const saleResult = insertSale.run(
      input.partyId ?? null,
      // Who was at the terminal (the counter account, or an elevated Owner) —
      // resolved from the session, never from the caller. Who *sold* it is the
      // next argument, and that one does come from the caller by design.
      user.id,
      salesmanId,
      input.paymentMode,
      cashAmount,
      upiAmount,
      creditAmount,
      subtotal,
      totalDiscount,
      grandTotal,
      isCashBill,
    )
    const saleId = saleResult.lastInsertRowid as number

    for (const item of input.items) {
      insertItem.run(
        saleId,
        item.itemName.trim(),
        item.barcode?.trim() || null,
        item.quantity,
        item.unitPrice,
        lineTotal({ quantity: item.quantity, unitPrice: item.unitPrice }),
      )
    }

    if (creditAmount > 0 && input.partyId != null) {
      adjustPartyBalance(db, input.partyId, creditAmount)
    }

    return saleId
  })

  const saleId = run()
  return getSaleById(db, saleId)!
}

/**
 * Permission enforcement for printing (PHASE7.md section 2), and — until
 * 2026-08-24 — the WhatsApp delivery gate as well.
 *
 * **The delivery condition is gone, at the client's request.** It used to
 * throw unless both WhatsApp sends had confirmed or an Owner had overridden,
 * which meant a resyncing session stopped the counter: no bill could be
 * printed while WhatsApp handed over its offline backlog, and the customer
 * waited. Sends are now queued and retried automatically
 * (`retryPendingBills`, electron/whatsapp/send.ts), so an undelivered bill is
 * a temporary state that resolves itself rather than a locked printer.
 *
 * What remains here is still real enforcement and still must not be skipped:
 * the caller must hold `sale:print`, and the sale must exist. Only the
 * delivery condition was removed — see `isBillDeliveryConfirmed`
 * (src/lib/printGate.ts) for what was traded away and what replaced it.
 */
export function assertSalePrintable(db: Database.Database, user: SafeUser, saleId: number): SaleRecord {
  assertPermission(user.role, 'sale:print')

  const sale = getSaleById(db, saleId)
  if (!sale) throw new Error(`Sale ${saleId} not found`)

  return sale
}

/**
 * Records a completed print. Split from `assertSalePrintable` above so the
 * IPC handler can check the gate *before* touching the printer and only call
 * this once the printer has actually accepted the job — `printed` is meant to
 * mean "this bill really came out", not "someone opened the print dialog and
 * then hit Cancel". Re-runs the same gate check itself so it stays safe to
 * call directly (and so the acceptance-criterion tests exercise the real
 * path).
 */
export function markSalePrinted(db: Database.Database, user: SafeUser, saleId: number): SaleRecord {
  assertSalePrintable(db, user, saleId)

  db.prepare('UPDATE sales SET printed = 1 WHERE id = ?').run(saleId)
  return getSaleById(db, saleId)!
}

/**
 * Owner-only override (PHASE6.md section 3), repurposed on 2026-08-24.
 *
 * It used to mean "print this bill anyway", because an unsent bill locked the
 * printer. Nothing locks the printer now, so what it means is **stop retrying
 * this bill**: `getSalesAwaitingWhatsApp` excludes overridden sales, so this
 * is how a bill that can never send — a wrong or unregistered number — leaves
 * the retry queue and the undelivered count. Without it such a bill would
 * retry on every reconnect forever and hold the count above zero forever,
 * which would teach the Owner to ignore the count; and that count is what now
 * stands in for the gate that used to block.
 *
 * The record it writes is unchanged and still worth having: not just that an
 * override happened (`print_override_used`, migration 002) but who decided and
 * which WhatsApp flags were still false at that moment (migration 006) — an
 * audit trail independent of the sale's live flags, which could in principle
 * change later. `assertPermission` here is the real enforcement point: a
 * Salesman session hitting this directly gets a PermissionError, same as any
 * other Owner-only write in this codebase.
 */
export function usePrintOverride(db: Database.Database, user: SafeUser, saleId: number): SaleRecord {
  assertPermission(user.role, 'sale:print_override')

  const sale = getSaleById(db, saleId)
  if (!sale) throw new Error(`Sale ${saleId} not found`)

  db.prepare(
    `UPDATE sales
     SET print_override_used = 1,
         print_override_by_user_id = ?,
         print_override_customer_sent_at_use = ?,
         print_override_owner_sent_at_use = ?,
         print_override_at = datetime('now')
     WHERE id = ?`,
  ).run(user.id, sale.whatsapp_customer_sent, sale.whatsapp_owner_sent, saleId)

  return getSaleById(db, saleId)!
}
