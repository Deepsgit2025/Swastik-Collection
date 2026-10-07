// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as salesmenModule from './salesmen.ts'
import {
  DuplicateSalesmanError,
  createSalesman,
  listSalesmen,
  renameSalesman,
  salesmanExists,
  setSalesmanActive,
} from './salesmen.ts'
import { createSale } from './sales.ts'
import { getSalesmanBreakdown } from './reports.ts'
import { PermissionError } from './permissions.ts'
import { todayRange } from '../lib/dateRange.ts'
import type { SafeUser } from '../types/user.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let owner: SafeUser
let counter: SafeUser

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const migrationsDir = path.join(__dirname, 'migrations')
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'))
  }

  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)',
  )
  const ownerId = insertUser.run('owner', 'x', 'owner', 'Shop Owner').lastInsertRowid as number
  const counterId = insertUser.run('__counter__', '!', 'salesman', 'Counter').lastInsertRowid as number

  owner = { id: ownerId, username: 'owner', role: 'owner', full_name: 'Shop Owner' }
  // What an un-unlocked window is. Every permission assertion below is
  // measured against this, because this is who is actually calling when
  // nobody has typed the Owner password.
  counter = { id: counterId, username: '__counter__', role: 'salesman', full_name: 'Counter' }
})

describe('listSalesmen', () => {
  it('is readable by the counter — the sale screen’s dropdown needs it', () => {
    createSalesman(db, owner, 'Anil')

    // Ungated by design, like `getParties`: a list of first names is not shop
    // data, and the till cannot credit a sale to somebody it cannot name.
    expect(listSalesmen(db).map((row) => row.name)).toEqual(['Anil'])
  })

  it('sorts by name, case-insensitively, so the dropdown order is stable', () => {
    createSalesman(db, owner, 'bhavna')
    createSalesman(db, owner, 'Anil')
    createSalesman(db, owner, 'Chetan')

    expect(listSalesmen(db).map((row) => row.name)).toEqual(['Anil', 'bhavna', 'Chetan'])
  })

  it('can narrow to the active ones, which is what the sale screen asks for', () => {
    const anil = createSalesman(db, owner, 'Anil')
    createSalesman(db, owner, 'Bhavna')
    setSalesmanActive(db, owner, anil.id, false)

    expect(listSalesmen(db, { activeOnly: true }).map((row) => row.name)).toEqual(['Bhavna'])
    expect(listSalesmen(db).map((row) => row.name)).toEqual(['Anil', 'Bhavna'])
  })
})

describe('createSalesman', () => {
  it('creates an active salesman with no login of any kind', () => {
    const created = createSalesman(db, owner, 'Anil Kumar')

    expect(created).toMatchObject({ name: 'Anil Kumar', is_active: 1, legacy_user_id: null })
    // The point of the whole change: this grants access to nothing, because
    // there is nothing here to sign in with.
    expect(created).not.toHaveProperty('username')
    expect(created).not.toHaveProperty('password_hash')
  })

  it('trims the name rather than storing a padded duplicate', () => {
    expect(createSalesman(db, owner, '  Anil  ').name).toBe('Anil')
  })

  it('rejects a blank name without creating anything', () => {
    expect(() => createSalesman(db, owner, '   ')).toThrow(/required/i)
    expect(listSalesmen(db)).toEqual([])
  })

  /** Two identical entries in the sale screen's dropdown are indistinguishable — the operator cannot pick the right one, so neither can the report. */
  it('rejects a duplicate name, ignoring case', () => {
    createSalesman(db, owner, 'Anil')

    expect(() => createSalesman(db, owner, 'Anil')).toThrow(DuplicateSalesmanError)
    expect(() => createSalesman(db, owner, 'anil')).toThrow(DuplicateSalesmanError)
    expect(listSalesmen(db)).toHaveLength(1)
  })

  it('rejects a counter session without creating anything', () => {
    expect(() => createSalesman(db, counter, 'Anil')).toThrow(PermissionError)
    expect(listSalesmen(db)).toEqual([])
  })
})

describe('renameSalesman', () => {
  it('renames, and the correction reaches every past bill', () => {
    const anil = createSalesman(db, owner, 'Annil')
    createSale(db, counter, {
      partyId: null,
      salesmanId: anil.id,
      items: [{ itemName: 'Saree', quantity: 1, unitPrice: 500 }],
      discount: 0,
      paymentMode: 'cash',
      cashAmount: 500,
      upiAmount: 0,
      creditAmount: 0,
    })

    renameSalesman(db, owner, anil.id, 'Anil')

    // Reports resolve the name by join rather than copying it onto the sale, so
    // a spelling fix is retroactive. That is intended — it is the same person —
    // and is why `renameSalesman` warns against recycling a row for a new one.
    expect(getSalesmanBreakdown(db, owner, todayRange())[0].salesmanName).toBe('Anil')
  })

  it('lets a name keep its own spelling — renaming to itself is not a clash', () => {
    const anil = createSalesman(db, owner, 'Anil')
    expect(() => renameSalesman(db, owner, anil.id, 'Anil')).not.toThrow()
  })

  it("rejects renaming onto somebody else's name", () => {
    createSalesman(db, owner, 'Anil')
    const bhavna = createSalesman(db, owner, 'Bhavna')

    expect(() => renameSalesman(db, owner, bhavna.id, 'anil')).toThrow(DuplicateSalesmanError)
  })

  it('rejects an unknown id', () => {
    expect(() => renameSalesman(db, owner, 999, 'Anil')).toThrow(/no longer exists/i)
  })

  it('rejects a counter session', () => {
    const anil = createSalesman(db, owner, 'Anil')
    expect(() => renameSalesman(db, counter, anil.id, 'Bhavna')).toThrow(PermissionError)
    expect(listSalesmen(db)[0].name).toBe('Anil')
  })
})

describe('setSalesmanActive', () => {
  /**
   * The whole reason retirement is a soft flag: a retired salesman must vanish
   * from the sale screen's dropdown while every bill they ever rang up keeps
   * reporting their name. A delete would do the first and destroy the second.
   */
  it('drops someone from the dropdown while their past sales keep their name', () => {
    const anil = createSalesman(db, owner, 'Anil')
    createSale(db, counter, {
      partyId: null,
      salesmanId: anil.id,
      items: [{ itemName: 'Saree', quantity: 1, unitPrice: 500 }],
      discount: 0,
      paymentMode: 'cash',
      cashAmount: 500,
      upiAmount: 0,
      creditAmount: 0,
    })

    setSalesmanActive(db, owner, anil.id, false)

    expect(listSalesmen(db, { activeOnly: true })).toEqual([])
    expect(getSalesmanBreakdown(db, owner, todayRange())[0]).toMatchObject({
      salesmanName: 'Anil',
      total: 500,
    })
  })

  it('brings someone back', () => {
    const anil = createSalesman(db, owner, 'Anil')
    setSalesmanActive(db, owner, anil.id, false)

    expect(setSalesmanActive(db, owner, anil.id, true).is_active).toBe(1)
    expect(listSalesmen(db, { activeOnly: true })).toHaveLength(1)
  })

  it('rejects an unknown id', () => {
    expect(() => setSalesmanActive(db, owner, 999, false)).toThrow(/no longer exists/i)
  })

  it('rejects a counter session', () => {
    const anil = createSalesman(db, owner, 'Anil')
    expect(() => setSalesmanActive(db, counter, anil.id, false)).toThrow(PermissionError)
    expect(listSalesmen(db)[0].is_active).toBe(1)
  })
})

describe('salesmanExists', () => {
  it('is what `createSale` uses to refuse an id pointing at nobody', () => {
    const anil = createSalesman(db, owner, 'Anil')

    expect(salesmanExists(db, anil.id)).toBe(true)
    expect(salesmanExists(db, 999)).toBe(false)
  })
})

/**
 * A deliberate absence, pinned so a later phase cannot quietly add one — the
 * same rule `users.ts` carries, for the same reason. Every bill references
 * `salesmen.id`; deleting a row would strip the attribution off all of it.
 */
describe('the module surface', () => {
  it('exports nothing that deletes a salesman', () => {
    expect(Object.keys(salesmenModule).sort()).toEqual([
      'DuplicateSalesmanError',
      'createSalesman',
      'listSalesmen',
      'renameSalesman',
      'resolveSalesmanForSale',
      'salesmanExists',
      'setSalesmanActive',
      'validateSalesmanName',
    ])
  })
})
