// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuplicateBarcodeError, createBarcodeLabel, getBarcodeLabelById, getBarcodeLabels } from './barcodeLabels.ts'
import type { SafeUser } from '../types/user.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let ownerId: number
let salesmanId: number
let owner: SafeUser
let salesman: SafeUser

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/001_init.sql'), 'utf-8'))
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/002_core_schema.sql'), 'utf-8'))
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/003_barcode_label_lines.sql'), 'utf-8'))

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
})

describe('createBarcodeLabel', () => {
  it('creates a label with a custom code for Owner', () => {
    const label = createBarcodeLabel(db, owner, { itemName: 'Cotton Saree', price: 1200, customCode: 'SAREE-001' })

    expect(label.item_name).toBe('Cotton Saree')
    expect(label.price).toBe(1200)
    expect(label.barcode_value).toBe('SAREE-001')
    expect(getBarcodeLabelById(db, label.id)).not.toBeNull()
  })

  it('also works for Salesman — barcode:create allows both roles per PHASE4.md section 6', () => {
    expect(() => createBarcodeLabel(db, salesman, { itemName: 'Silk Dupatta', price: 400 })).not.toThrow()
  })

  it('auto-generates a unique barcode value when no custom code is given', () => {
    const first = createBarcodeLabel(db, owner, { itemName: 'Item A' })
    const second = createBarcodeLabel(db, owner, { itemName: 'Item B' })

    expect(first.barcode_value).toBeTruthy()
    expect(second.barcode_value).toBeTruthy()
    expect(first.barcode_value).not.toBe(second.barcode_value)
  })

  it('defaults price to null when omitted', () => {
    const label = createBarcodeLabel(db, owner, { itemName: 'No Price Item' })
    expect(label.price).toBeNull()
  })

  it('rejects a blank item name', () => {
    expect(() => createBarcodeLabel(db, owner, { itemName: '   ' })).toThrow('Item name is required')
  })

  it('rejects a negative price', () => {
    expect(() => createBarcodeLabel(db, owner, { itemName: 'Bad Price', price: -5 })).toThrow(
      'Price must be a non-negative number',
    )
  })

  it('throws a clear DuplicateBarcodeError, not a raw DB crash, when a custom code is reused', () => {
    createBarcodeLabel(db, owner, { itemName: 'First Item', customCode: 'DUP-CODE' })

    expect(() => createBarcodeLabel(db, owner, { itemName: 'Second Item', customCode: 'DUP-CODE' })).toThrow(
      DuplicateBarcodeError,
    )
    expect(() => createBarcodeLabel(db, owner, { itemName: 'Second Item', customCode: 'DUP-CODE' })).toThrow(
      /already in use/,
    )

    // Confirms the failed attempt didn't leave a partial row behind.
    expect(getBarcodeLabels(db)).toHaveLength(1)
  })

  it('saves header/line1-4 tag lines, trimmed, defaulting to null when blank', () => {
    const label = createBarcodeLabel(db, owner, {
      itemName: 'Cotton Kurta',
      header: '  Swastik Collection  ',
      line1: 'Size: XL',
      line2: '   ',
    })

    expect(label.header).toBe('Swastik Collection')
    expect(label.line1).toBe('Size: XL')
    expect(label.line2).toBeNull()
    expect(label.line3).toBeNull()
    expect(label.line4).toBeNull()
  })

  it('treats a reused code as a duplicate regardless of surrounding whitespace', () => {
    createBarcodeLabel(db, owner, { itemName: 'First Item', customCode: 'WS-CODE' })
    expect(() => createBarcodeLabel(db, owner, { itemName: 'Second Item', customCode: '  WS-CODE  ' })).toThrow(
      DuplicateBarcodeError,
    )
  })
})

describe('getBarcodeLabels', () => {
  it('lists labels newest first', () => {
    createBarcodeLabel(db, owner, { itemName: 'Older Item', customCode: 'OLD-1' })
    createBarcodeLabel(db, owner, { itemName: 'Newer Item', customCode: 'NEW-1' })

    const rows = getBarcodeLabels(db)
    expect(rows.map((r) => r.item_name)).toEqual(['Newer Item', 'Older Item'])
  })

  it('filters by item name or barcode value search', () => {
    createBarcodeLabel(db, owner, { itemName: 'Cotton Saree', customCode: 'SAREE-001' })
    createBarcodeLabel(db, owner, { itemName: 'Silk Dupatta', customCode: 'DUPATTA-001' })

    expect(getBarcodeLabels(db, { search: 'saree' }).map((r) => r.item_name)).toEqual(['Cotton Saree'])
    expect(getBarcodeLabels(db, { search: 'DUPATTA-001' }).map((r) => r.item_name)).toEqual(['Silk Dupatta'])
    expect(getBarcodeLabels(db, { search: 'nonexistent' })).toEqual([])
  })
})
