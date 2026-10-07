// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSalesHistoryCsv, exportFullSalesHistory, getFullSalesHistoryRows } from './salesExport.ts'
import { createSale } from './sales.ts'
import { createParty } from './parties.ts'
import type { SafeUser } from '../types/user.ts'

/**
 * The full-history export (PHASE12.md section 4) — the Owner's way of keeping
 * anything permanently before the retention rule removes it.
 *
 * The load-bearing behaviour here is the bill-level blanking: a column that
 * looks summable and is not would be worse than no export at all, given this is
 * the file someone reaches for when they want a permanent record.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let owner: SafeUser
let salesman: SafeUser
/** The `salesmen` row the export's "Sold By" column resolves through. */
let testSalesmanId: number

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const dir = path.join(__dirname, 'migrations')
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), 'utf-8'))
  }

  const ownerId = db
    .prepare("INSERT INTO users (username, password_hash, role, full_name) VALUES ('owner', 'x', 'owner', 'Shop Owner')")
    .run().lastInsertRowid as number
  const salesmanId = db
    .prepare(
      "INSERT INTO users (username, password_hash, role, full_name) VALUES ('salesman1', 'x', 'salesman', 'Test Salesman')",
    )
    .run().lastInsertRowid as number

  owner = { id: ownerId, username: 'owner', role: 'owner', full_name: 'Shop Owner' }
  salesman = { id: salesmanId, username: 'salesman1', role: 'salesman', full_name: 'Test Salesman' }

  // Attribution moved off `users` on 2026-08-27 — the export joins `salesmen`
  // now, so the "Sold By" column needs a row there to resolve.
  testSalesmanId = db
    .prepare("INSERT INTO salesmen (name) VALUES ('Test Salesman')")
    .run().lastInsertRowid as number
})

/** A three-line cash bill — the shape that makes a repeated grand total wrong. */
function threeLineCashSale() {
  return createSale(db, owner, {
    partyId: null,
    items: [
      { itemName: 'Cotton Saree', quantity: 2, unitPrice: 300 },
      { itemName: 'Silk Scarf', quantity: 1, unitPrice: 250 },
      { itemName: 'Cloth Bag', quantity: 3, unitPrice: 50 },
    ],
    discount: 0,
    paymentMode: 'cash',
    cashAmount: 1000,
    upiAmount: 0,
    creditAmount: 0,
  })
}

/**
 * A small RFC4180 reader, so assertions read the real document rather than the
 * array behind it — and so a quoted cell containing a comma is parsed as one
 * cell, which a naive split on commas gets wrong in exactly the case worth
 * testing.
 */
function csvRows(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  const text = csv.replace(/^﻿/, '')
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"') {
        inQuotes = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else {
      cell += char
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

describe('getFullSalesHistoryRows', () => {
  it('returns one row per line item, oldest first', () => {
    threeLineCashSale()
    const rows = getFullSalesHistoryRows(db)

    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.item_name)).toEqual(['Cotton Saree', 'Silk Scarf', 'Cloth Bag'])
    expect(new Set(rows.map((r) => r.sale_id)).size).toBe(1)
  })

  it('carries the customer when there is one and says walk-in when there is not', () => {
    const party = createParty(db, owner, { name: 'Ramesh Kumar', phone: '9876500001', address: null, openingBalance: 0 })
    createSale(db, owner, {
      partyId: party.id,
      items: [{ itemName: 'Cotton Saree', quantity: 1, unitPrice: 500 }],
      discount: 0,
      paymentMode: 'credit',
      cashAmount: 0,
      upiAmount: 0,
      creditAmount: 500,
    })
    threeLineCashSale()

    const csv = buildSalesHistoryCsv(getFullSalesHistoryRows(db))
    expect(csv).toContain('Ramesh Kumar')
    expect(csv).toContain('Walk-in Customer')
  })

  it('records who sold it, from the salesman picked on the bill', () => {
    createSale(db, salesman, {
      partyId: null,
      salesmanId: testSalesmanId,
      items: [{ itemName: 'Cotton Saree', quantity: 1, unitPrice: 500 }],
      discount: 0,
      paymentMode: 'cash',
      cashAmount: 500,
      upiAmount: 0,
      creditAmount: 0,
    })
    expect(getFullSalesHistoryRows(db)[0].salesman).toBe('Test Salesman')
  })

  /**
   * A **LEFT** join, where this used to be an inner `JOIN users`. The salesman
   * field became optional on 2026-08-27, so an inner join would now silently
   * drop unassigned bills out of an export whose entire purpose is to be the
   * complete record — the worst possible failure for this file, because the
   * output would still look perfectly well-formed.
   */
  it('still exports a bill with no salesman picked, as Unassigned', () => {
    createSale(db, salesman, {
      partyId: null,
      salesmanId: null,
      items: [{ itemName: 'Cotton Saree', quantity: 1, unitPrice: 500 }],
      discount: 0,
      paymentMode: 'cash',
      cashAmount: 500,
      upiAmount: 0,
      creditAmount: 0,
    })

    const rows = getFullSalesHistoryRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].salesman).toBe('Unassigned')
  })

  /** Retention treats the two entirely differently, so the export has to say which is which. */
  it('labels cash bills and credit sales distinctly', () => {
    threeLineCashSale()
    const party = createParty(db, owner, { name: 'Credit Customer', phone: '9876500002', address: null, openingBalance: 0 })
    createSale(db, owner, {
      partyId: party.id,
      items: [{ itemName: 'Silk Scarf', quantity: 1, unitPrice: 400 }],
      discount: 0,
      paymentMode: 'credit',
      cashAmount: 0,
      upiAmount: 0,
      creditAmount: 400,
    })

    const types = new Set(getFullSalesHistoryRows(db).map((r) => r.bill_type))
    expect(types).toEqual(new Set(['Cash bill', 'Credit']))
  })

  /**
   * `created_at` is UTC and the shop's day is local. An unconverted export would
   * file the first hours of every IST morning against the previous day and
   * disagree with every screen in the app — the trap `reports.ts` documents.
   */
  it('converts timestamps to the shop clock', () => {
    threeLineCashSale()
    db.prepare("UPDATE sales SET created_at = '2026-08-25 20:30:00'").run()

    const localStamp = (
      db.prepare("SELECT datetime('2026-08-25 20:30:00', 'localtime') AS t").get() as { t: string }
    ).t
    expect(getFullSalesHistoryRows(db)[0].local_created_at).toBe(localStamp)
  })

  it('is empty on a database with no sales, rather than failing', () => {
    expect(getFullSalesHistoryRows(db)).toEqual([])
    expect(() => buildSalesHistoryCsv([])).not.toThrow()
  })
})

describe('buildSalesHistoryCsv', () => {
  /**
   * **The decision this file exists to protect.** Repeating the grand total
   * against every line makes `SUM(Bill Grand Total)` count a three-item bill
   * three times — and summing that column is the first thing anyone opening
   * this in Excel does. Blanking the continuation rows makes both that sum and
   * `SUM(Line Total)` correct.
   */
  it('puts the bill totals on the first row of a bill only', () => {
    threeLineCashSale()
    const rows = csvRows(buildSalesHistoryCsv(getFullSalesHistoryRows(db)))

    const headers = rows[0]
    const grandTotalAt = headers.indexOf('Bill Grand Total')
    const lineTotalAt = headers.indexOf('Line Total')
    const body = rows.slice(1)

    expect(body).toHaveLength(3)
    expect(body[0][grandTotalAt]).toBe('1000')
    expect(body[1][grandTotalAt]).toBe('')
    expect(body[2][grandTotalAt]).toBe('')

    // Both columns now add up to the right thing.
    const sumOf = (index: number) =>
      body.reduce((total, row) => total + (row[index] === '' ? 0 : Number(row[index])), 0)
    expect(sumOf(grandTotalAt)).toBe(1000)
    expect(sumOf(lineTotalAt)).toBe(1000)
  })

  it('repeats the bill number on every row so the grouping is still readable', () => {
    threeLineCashSale()
    const rows = csvRows(buildSalesHistoryCsv(getFullSalesHistoryRows(db)))
    const body = rows.slice(1)
    expect(body.map((row) => row[0])).toEqual(['1', '1', '1'])
  })

  it('restarts the totals on the next bill', () => {
    threeLineCashSale()
    createSale(db, owner, {
      partyId: null,
      items: [{ itemName: 'Silk Scarf', quantity: 1, unitPrice: 250 }],
      discount: 0,
      paymentMode: 'upi',
      cashAmount: 0,
      upiAmount: 250,
      creditAmount: 0,
    })

    const rows = csvRows(buildSalesHistoryCsv(getFullSalesHistoryRows(db)))
    const grandTotalAt = rows[0].indexOf('Bill Grand Total')
    const body = rows.slice(1)

    expect(body.map((row) => row[grandTotalAt])).toEqual(['1000', '', '', '250'])
  })

  /** Same reasoning as every other export here: raw numbers, so the column is summable rather than a set of ₹-prefixed strings. */
  it('writes money as raw numbers, not formatted currency', () => {
    threeLineCashSale()
    const csv = buildSalesHistoryCsv(getFullSalesHistoryRows(db))
    expect(csv).not.toContain('₹')
    expect(csv).toContain('1000')
  })

  it('carries the UTF-8 BOM and CRLF line endings Excel needs', () => {
    threeLineCashSale()
    const csv = buildSalesHistoryCsv(getFullSalesHistoryRows(db))
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('\r\n')
  })

  it('quotes an item name containing a comma rather than splitting the row', () => {
    createSale(db, owner, {
      partyId: null,
      items: [{ itemName: 'Saree, red', quantity: 1, unitPrice: 500 }],
      discount: 0,
      paymentMode: 'cash',
      cashAmount: 500,
      upiAmount: 0,
      creditAmount: 0,
    })

    const csv = buildSalesHistoryCsv(getFullSalesHistoryRows(db))
    expect(csv).toContain('"Saree, red"')
    expect(csvRows(csv)[1]).toHaveLength(csvRows(csv)[0].length)
  })
})

describe('exportFullSalesHistory', () => {
  it('reports how many bills and rows it wrote', () => {
    threeLineCashSale()
    const result = exportFullSalesHistory(db, owner)

    expect(result.saleCount).toBe(1)
    expect(result.rowCount).toBe(3)
    expect(result.csv).toContain('Bill No.')
  })

  /** Open to the counter since 2026-09-19 (the Owner lock was removed) — it only reads, via the same `report:view_all` Phase 11's export uses. */
  it('is open to the counter, since it only reads', () => {
    expect(() => exportFullSalesHistory(db, salesman)).not.toThrow()
  })
})
