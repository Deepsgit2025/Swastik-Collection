import type Database from 'better-sqlite3'
import type { BarcodeLabelListFilters, BarcodeLabelRow, CreateBarcodeLabelInput } from '../types/barcodeLabel.ts'
import type { SafeUser } from '../types/user.ts'
import { assertPermission } from './permissions.ts'

/** Thrown instead of letting the `barcode_value UNIQUE` constraint surface as a raw SQLite crash (PHASE4.md section 8, acceptance criterion 3). */
export class DuplicateBarcodeError extends Error {
  constructor(code: string) {
    super(`The code "${code}" is already in use by another label. Choose a different code, or leave it blank to auto-generate one.`)
    this.name = 'DuplicateBarcodeError'
  }
}

function barcodeValueExists(db: Database.Database, value: string): boolean {
  return db.prepare('SELECT 1 FROM barcode_labels WHERE barcode_value = ?').get(value) != null
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}

/** Random Code128-safe value, re-rolled on the rare collision against existing rows. */
function generateBarcodeValue(db: Database.Database): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `SC${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0')}`
    if (!barcodeValueExists(db, candidate)) return candidate
  }
  throw new Error('Could not generate a unique barcode value. Please try again.')
}

const LABEL_COLUMNS = 'id, item_name, price, barcode_value, header, line1, line2, line3, line4, created_by_user_id, created_at'

export function getBarcodeLabelById(db: Database.Database, id: number): BarcodeLabelRow | null {
  const row = db.prepare(`SELECT ${LABEL_COLUMNS} FROM barcode_labels WHERE id = ?`).get(id) as
    | BarcodeLabelRow
    | undefined
  return row ?? null
}

/** Label history (PHASE4.md section 2: saved for future reference/reprint). Both roles can view per section 6, so no assertPermission gate is needed beyond an actual logged-in session (enforced at the IPC layer). */
export function getBarcodeLabels(db: Database.Database, filters: BarcodeLabelListFilters = {}): BarcodeLabelRow[] {
  const conditions: string[] = []
  const params: unknown[] = []

  const search = filters.search?.trim()
  if (search) {
    conditions.push('(item_name LIKE ? OR barcode_value LIKE ?)')
    const term = `%${search}%`
    params.push(term, term)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // Applied after the ORDER BY, so a limited call returns the *newest* N rather
  // than an arbitrary N — which is what the sale screen's dropdown wants when
  // it asks with no search term at all.
  let limitClause = ''
  if (filters.limit != null && filters.limit > 0) {
    limitClause = 'LIMIT ?'
    params.push(Math.floor(filters.limit))
  }

  // `created_at` (`datetime('now')`) only has second-level resolution, so two
  // labels created within the same second tie on it — break ties by id DESC
  // so newest-first ordering still holds deterministically.
  return db
    .prepare(
      `SELECT ${LABEL_COLUMNS} FROM barcode_labels ${where} ORDER BY created_at DESC, id DESC ${limitClause}`,
    )
    .all(...params) as BarcodeLabelRow[]
}

/**
 * Generates and saves a new barcode label (PHASE4.md section 2). If
 * `customCode` is blank, a unique value is auto-generated; if given and
 * already taken by another label, throws `DuplicateBarcodeError` rather than
 * a raw DB crash. The pre-check below covers the common case with a clear
 * message; the catch around the insert is a race-guard for the rare case of
 * two labels being created with the same custom code at nearly the same
 * moment (the `barcode_value UNIQUE` column constraint is the real backstop).
 */
export function createBarcodeLabel(db: Database.Database, user: SafeUser, data: CreateBarcodeLabelInput): BarcodeLabelRow {
  assertPermission(user.role, 'barcode:create')

  const itemName = data.itemName.trim()
  if (!itemName) throw new Error('Item name is required')

  if (data.price != null && (Number.isNaN(data.price) || data.price < 0)) {
    throw new Error('Price must be a non-negative number')
  }

  const customCode = data.customCode?.trim() || null
  if (customCode && barcodeValueExists(db, customCode)) {
    throw new DuplicateBarcodeError(customCode)
  }

  const barcodeValue = customCode ?? generateBarcodeValue(db)

  try {
    const result = db
      .prepare(
        `INSERT INTO barcode_labels (item_name, price, barcode_value, header, line1, line2, line3, line4, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        itemName,
        data.price ?? null,
        barcodeValue,
        data.header?.trim() || null,
        data.line1?.trim() || null,
        data.line2?.trim() || null,
        data.line3?.trim() || null,
        data.line4?.trim() || null,
        user.id,
      )

    return getBarcodeLabelById(db, result.lastInsertRowid as number)!
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new DuplicateBarcodeError(barcodeValue)
    throw err
  }
}
