// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLabelSize, getShopSettings, setLabelSize, setShopSettings } from './settings.ts'
import { DEFAULT_LABEL_HEIGHT_MM, DEFAULT_LABEL_WIDTH_MM } from '../lib/labelLayout.ts'
import type { SafeUser } from '../types/user.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let owner: SafeUser
let salesman: SafeUser

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/001_init.sql'), 'utf-8'))
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/002_core_schema.sql'), 'utf-8'))

  const ownerId = db
    .prepare(`INSERT INTO users (username, password_hash, role, full_name) VALUES ('owner', 'x', 'owner', 'Shop Owner')`)
    .run().lastInsertRowid as number
  const salesmanId = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, full_name) VALUES ('salesman1', 'x', 'salesman', 'Test Salesman')`,
    )
    .run().lastInsertRowid as number

  owner = { id: ownerId, username: 'owner', role: 'owner', full_name: 'Shop Owner' }
  salesman = { id: salesmanId, username: 'salesman1', role: 'salesman', full_name: 'Test Salesman' }
})

describe('getLabelSize', () => {
  it('falls back to the original 50mm x 25mm default when nothing is saved yet', () => {
    expect(getLabelSize(db)).toEqual({ widthMm: DEFAULT_LABEL_WIDTH_MM, heightMm: DEFAULT_LABEL_HEIGHT_MM })
  })

  it('reflects a saved size', () => {
    setLabelSize(db, owner, { widthMm: 60, heightMm: 30 })
    expect(getLabelSize(db)).toEqual({ widthMm: 60, heightMm: 30 })
  })
})

describe('setLabelSize', () => {
  it('persists a valid size for Owner', () => {
    const result = setLabelSize(db, owner, { widthMm: 40, heightMm: 20 })
    expect(result).toEqual({ widthMm: 40, heightMm: 20 })
  })

  it('overwrites a previously saved size rather than erroring on the second save', () => {
    setLabelSize(db, owner, { widthMm: 40, heightMm: 20 })
    setLabelSize(db, owner, { widthMm: 75, heightMm: 35 })
    expect(getLabelSize(db)).toEqual({ widthMm: 75, heightMm: 35 })
  })

  it('rejects Salesman — settings:edit is Owner-only', () => {
    expect(() => setLabelSize(db, salesman, { widthMm: 40, heightMm: 20 })).toThrow(
      "Role 'salesman' cannot perform 'settings:edit'",
    )
  })

  it('rejects a width outside the sane bounds', () => {
    expect(() => setLabelSize(db, owner, { widthMm: 5, heightMm: 20 })).toThrow('Label width must be between')
    expect(() => setLabelSize(db, owner, { widthMm: 200, heightMm: 20 })).toThrow('Label width must be between')
  })

  it('rejects a height outside the sane bounds', () => {
    expect(() => setLabelSize(db, owner, { widthMm: 40, heightMm: 5 })).toThrow('Label height must be between')
    expect(() => setLabelSize(db, owner, { widthMm: 40, heightMm: 200 })).toThrow('Label height must be between')
  })

  it('does not save anything when the Owner check passes but validation fails', () => {
    expect(() => setLabelSize(db, owner, { widthMm: 40, heightMm: 5 })).toThrow()
    expect(getLabelSize(db)).toEqual({ widthMm: DEFAULT_LABEL_WIDTH_MM, heightMm: DEFAULT_LABEL_HEIGHT_MM })
  })
})

/**
 * Shop details (PHASE12.md section 1) — the values that replaced Phase 6's
 * `electron/whatsapp/config.ts` and Phase 7's `src/lib/shopInfo.ts` constants.
 *
 * The migration that seeds them is applied only where a test needs the seeded
 * values; the cases below start from an empty `settings` table so the
 * fallback behaviour is asserted directly rather than assumed.
 */
const VALID_SHOP = {
  shopName: 'Test Shop',
  shopAddress: '9 Test Lane',
  shopPhone: '9000000001',
  ownerWhatsappNumber: '9000000002',
}

describe('getShopSettings', () => {
  it('falls back to empty strings rather than to any hardcoded shop identity', () => {
    expect(getShopSettings(db)).toEqual({
      shopName: '',
      shopAddress: '',
      shopPhone: '',
      ownerWhatsappNumber: '',
    })
  })

  it('reads the values migration 009 seeds as empty strings, so an existing install starts fresh', () => {
    db.exec(fs.readFileSync(path.join(__dirname, 'migrations/009_shop_settings.sql'), 'utf-8'))
    const shop = getShopSettings(db)
    expect(shop.shopName).toBe('')
    expect(shop.shopPhone).toBe('')
    expect(shop.ownerWhatsappNumber).toBe('')
    expect(shop.shopAddress).toBe('')
  })

  it('is not re-seeded over an Owner edit when the migration is applied again', () => {
    db.exec(fs.readFileSync(path.join(__dirname, 'migrations/009_shop_settings.sql'), 'utf-8'))
    setShopSettings(db, owner, { ...VALID_SHOP, shopName: 'Owner Chosen Name' })
    db.exec(fs.readFileSync(path.join(__dirname, 'migrations/009_shop_settings.sql'), 'utf-8'))
    expect(getShopSettings(db).shopName).toBe('Owner Chosen Name')
  })
})

describe('setShopSettings', () => {
  it('persists all four fields for Owner and reads back identically', () => {
    expect(setShopSettings(db, owner, VALID_SHOP)).toEqual(VALID_SHOP)
    expect(getShopSettings(db)).toEqual(VALID_SHOP)
  })

  it('trims each field, so what is stored is what the bill prints', () => {
    const saved = setShopSettings(db, owner, {
      shopName: '  Test Shop  ',
      shopAddress: '  9 Test Lane  ',
      shopPhone: '  9000000001 ',
      ownerWhatsappNumber: ' 9000000002  ',
    })
    expect(saved).toEqual(VALID_SHOP)
    expect(getShopSettings(db)).toEqual(VALID_SHOP)
  })

  it('overwrites a previous save rather than erroring on the second one', () => {
    setShopSettings(db, owner, VALID_SHOP)
    setShopSettings(db, owner, { ...VALID_SHOP, shopName: 'Second Name' })
    expect(getShopSettings(db).shopName).toBe('Second Name')
  })

  it('rejects Salesman — settings:edit is Owner-only', () => {
    expect(() => setShopSettings(db, salesman, VALID_SHOP)).toThrow(
      "Role 'salesman' cannot perform 'settings:edit'",
    )
    expect(getShopSettings(db).shopName).toBe('')
  })

  it('accepts a blank address — it is the one optional field', () => {
    expect(setShopSettings(db, owner, { ...VALID_SHOP, shopAddress: '' }).shopAddress).toBe('')
  })

  it('rejects a blank shop name', () => {
    expect(() => setShopSettings(db, owner, { ...VALID_SHOP, shopName: '   ' })).toThrow(
      'Shop name is required',
    )
  })

  it('rejects a blank shop phone', () => {
    expect(() => setShopSettings(db, owner, { ...VALID_SHOP, shopPhone: '' })).toThrow(
      'Shop phone is required',
    )
  })

  /**
   * The important one. `getSalesAwaitingWhatsApp` counts any sale with
   * `whatsapp_owner_sent = 0` as still owed, unconditionally — so a blank
   * Owner number would park every future bill in the "not sent" queue forever.
   */
  it('rejects a blank Owner WhatsApp number', () => {
    expect(() => setShopSettings(db, owner, { ...VALID_SHOP, ownerWhatsappNumber: '  ' })).toThrow(
      "The Owner's WhatsApp number is required",
    )
  })

  it('rejects an Owner WhatsApp number that is too short to be a real mobile', () => {
    expect(() => setShopSettings(db, owner, { ...VALID_SHOP, ownerWhatsappNumber: '99887' })).toThrow(
      '10-digit mobile number',
    )
  })

  /**
   * All four fields are validated before any is written, so a rejected save
   * can't leave half a form committed with no way to tell which half landed.
   */
  it('writes nothing at all when one field fails validation', () => {
    setShopSettings(db, owner, VALID_SHOP)
    expect(() =>
      setShopSettings(db, owner, {
        shopName: 'Half Saved Name',
        shopAddress: 'Half Saved Address',
        shopPhone: '9000000009',
        ownerWhatsappNumber: '',
      }),
    ).toThrow()
    expect(getShopSettings(db)).toEqual(VALID_SHOP)
  })
})
