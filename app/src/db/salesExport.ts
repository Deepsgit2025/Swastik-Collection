import type Database from 'better-sqlite3'
import { assertPermission } from './permissions.js'
import { toCsv, type CsvCell } from '../lib/csv.js'
import { UNASSIGNED_SALESMAN_LABEL } from './reports.js'
import type { SafeUser } from '../types/user.js'

/**
 * Full sales-history export (PHASE12.md section 4).
 *
 * Deliberately independent of Phase 11's report exports, and for a stated
 * reason: this exists **so the Owner can keep permanently whatever they want
 * before the day-90 retention window closes on it**. That makes it an archival
 * dump, not an analysis view — no range, no summary, every sale still in the
 * database with its line items.
 *
 * **Built main-side, unlike every Phase 11 export.** Those are assembled in the
 * renderer from the state the screen is displaying, because a report's file
 * must match the figures the Owner is looking at (acceptance criterion 4 of
 * Phase 11). Here there *is* no displayed state — the whole point is to dump
 * everything, including years the app has never rendered on one screen — so
 * shipping tens of thousands of rows to the renderer purely to have them
 * assembled and sent back would be work in aid of a rule that does not apply.
 *
 * Gated by `report:view_all` — the same Owner-only action Phase 11's
 * `reports:exportCsv` already uses, since this is the same claim (see all of
 * the shop's data) rather than a new one. **No new Action, so the permission
 * harness stays at 48 checks.**
 */

interface ExportRow {
  sale_id: number
  local_created_at: string
  bill_type: string
  customer: string | null
  customer_phone: string | null
  salesman: string
  payment_mode: string
  item_name: string | null
  barcode: string | null
  quantity: number | null
  unit_price: number | null
  line_total: number | null
  subtotal: number
  total_discount: number
  grand_total: number
  cash_amount: number
  upi_amount: number
  credit_amount: number
}

/**
 * One row per line item, oldest first.
 *
 * `LEFT JOIN sale_items` rather than an inner join: a sale with no items should
 * be impossible (`createSale` rejects an empty cart), but if one ever existed it
 * must not vanish silently from the export that is supposed to be a complete
 * record.
 *
 * Timestamps are converted with `'localtime'`, the same discipline
 * `src/db/reports.ts` documents: `created_at` is UTC and the shop's day is
 * local, so an unconverted export would file the first hours of every IST
 * morning against the previous day and disagree with every screen in the app.
 *
 * "Sold By" resolves through `salesmen`, not `users` — attribution moved off
 * logins on 2026-08-27. It is a **LEFT** join now, where the old `JOIN users`
 * was inner: `salesman_id` is null for a bill saved with no salesman picked,
 * and an inner join would silently drop those bills out of an export whose
 * entire purpose is to be the complete record. They export as
 * `UNASSIGNED_SALESMAN_LABEL` instead. Every bill written before the move
 * carries a real name here, backfilled by migration 012.
 */
export function getFullSalesHistoryRows(db: Database.Database): ExportRow[] {
  return db
    .prepare(
      `SELECT s.id                                  AS sale_id,
              datetime(s.created_at, 'localtime')   AS local_created_at,
              CASE WHEN s.is_cash_bill = 1 THEN 'Cash bill' ELSE 'Credit' END AS bill_type,
              p.name                                AS customer,
              p.phone                               AS customer_phone,
              COALESCE(sm.name, ?)                  AS salesman,
              s.payment_mode                        AS payment_mode,
              i.item_name                           AS item_name,
              i.barcode                             AS barcode,
              i.quantity                            AS quantity,
              i.unit_price                          AS unit_price,
              i.line_total                          AS line_total,
              s.subtotal, s.total_discount, s.grand_total,
              s.cash_amount, s.upi_amount, s.credit_amount
         FROM sales s
         LEFT JOIN sale_items i ON i.sale_id = s.id
         LEFT JOIN parties p    ON p.id = s.party_id
         LEFT JOIN salesmen sm  ON sm.id = s.salesman_id
        ORDER BY s.id ASC, i.id ASC`,
    )
    .all(UNASSIGNED_SALESMAN_LABEL) as ExportRow[]
}

const HEADERS: CsvCell[] = [
  'Bill No.',
  'Date',
  'Bill Type',
  'Customer',
  'Customer Phone',
  'Sold By',
  'Payment Mode',
  'Item',
  'Barcode',
  'Quantity',
  'Unit Price',
  'Line Total',
  'Bill Subtotal',
  'Bill Discount',
  'Bill Grand Total',
  'Cash',
  'UPI',
  'Credit',
]

/**
 * The finished CSV.
 *
 * **The bill-level money columns are filled on a bill's first row only, and
 * left blank on its remaining item rows.** That is the one real decision in
 * this file. Repeating the grand total against every line — the usual shape for
 * a flat export — makes `SUM(Bill Grand Total)` silently count a three-item
 * bill three times, and summing that column is the very first thing anyone
 * opening this in Excel will do. Blanking the continuation rows makes both
 * `SUM(Line Total)` and `SUM(Bill Grand Total)` correct, at the cost of some
 * empty cells; the bill number repeats on every row, so the grouping is still
 * plain to read.
 *
 * This is the same class of trap Phase 11 documents for the JOIN fan-out in
 * `getSalesmanSales` — a number that looks right and is not.
 *
 * Money goes in as raw numbers rather than `formatCurrency` output, matching
 * every other export here: same values, unformatted, so the column adds up.
 */
export function buildSalesHistoryCsv(rows: ExportRow[]): string {
  let previousSaleId: number | null = null

  const body = rows.map((row): CsvCell[] => {
    const firstRowOfBill = row.sale_id !== previousSaleId
    previousSaleId = row.sale_id

    return [
      row.sale_id,
      row.local_created_at,
      row.bill_type,
      row.customer ?? 'Walk-in Customer',
      row.customer_phone,
      row.salesman,
      row.payment_mode,
      row.item_name,
      row.barcode,
      row.quantity,
      row.unit_price,
      row.line_total,
      firstRowOfBill ? row.subtotal : null,
      firstRowOfBill ? row.total_discount : null,
      firstRowOfBill ? row.grand_total : null,
      firstRowOfBill ? row.cash_amount : null,
      firstRowOfBill ? row.upi_amount : null,
      firstRowOfBill ? row.credit_amount : null,
    ]
  })

  return toCsv(HEADERS, body)
}

/** Owner-only. Returns the finished document plus how many bills it covers, so the screen can say what was written without re-counting it. */
export function exportFullSalesHistory(
  db: Database.Database,
  user: SafeUser,
): { csv: string; saleCount: number; rowCount: number } {
  assertPermission(user.role, 'report:view_all')

  const rows = getFullSalesHistoryRows(db)
  return {
    csv: buildSalesHistoryCsv(rows),
    saleCount: new Set(rows.map((row) => row.sale_id)).size,
    rowCount: rows.length,
  }
}
