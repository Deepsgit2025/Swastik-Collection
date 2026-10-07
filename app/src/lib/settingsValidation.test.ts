// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  validateFullName,
  validateOwnerWhatsAppNumber,
  validatePassword,
  validateShopAddress,
  validateShopName,
  validateShopPhone,
  validateUsername,
} from './settingsValidation.ts'

/**
 * These are the same functions `setShopSettings` and `createSalesmanUser` call
 * to gate their writes (src/db/settings.ts, src/db/users.ts) and the same ones
 * `SettingsScreen` calls for its inline errors — the two-layer discipline
 * `saleMath.ts`/`paymentMath.ts`/`expenseMath.ts` already follow. Testing them
 * here is what makes both layers provably identical rather than similar.
 */

describe('validateShopName', () => {
  it('accepts an ordinary name', () => {
    expect(validateShopName('Shree Swastik Collections')).toBeNull()
  })

  it('rejects blank and whitespace-only', () => {
    expect(validateShopName('')).toMatch(/required/)
    expect(validateShopName('   ')).toMatch(/required/)
  })

  it('rejects a name too long to fit a 4-inch bill header', () => {
    expect(validateShopName('x'.repeat(81))).toMatch(/80 characters or fewer/)
    expect(validateShopName('x'.repeat(80))).toBeNull()
  })
})

describe('validateShopAddress', () => {
  it('accepts blank — the address is the one optional shop field', () => {
    expect(validateShopAddress('')).toBeNull()
    expect(validateShopAddress('   ')).toBeNull()
  })

  it('accepts a real address and rejects an overlong one', () => {
    expect(validateShopAddress('12 MG Road, Pune - 411001')).toBeNull()
    expect(validateShopAddress('x'.repeat(201))).toMatch(/200 characters or fewer/)
  })
})

describe('validateShopPhone', () => {
  it('accepts a bare 10-digit number and a country-code form', () => {
    expect(validateShopPhone('9644570828')).toBeNull()
    expect(validateShopPhone('919644570828')).toBeNull()
  })

  it('ignores punctuation people actually type', () => {
    expect(validateShopPhone('+91 96445-70828')).toBeNull()
  })

  it('rejects blank and anything too short or too long to be a number', () => {
    expect(validateShopPhone('')).toMatch(/required/)
    expect(validateShopPhone('96445')).toMatch(/10-digit/)
    expect(validateShopPhone('9'.repeat(16))).toMatch(/10-digit/)
  })
})

describe('validateOwnerWhatsAppNumber', () => {
  it('accepts a bare 10-digit number — the country code is added at send time', () => {
    expect(validateOwnerWhatsAppNumber('9981956265')).toBeNull()
    expect(validateOwnerWhatsAppNumber('919981956265')).toBeNull()
  })

  /**
   * Blank is the case that matters: `getSalesAwaitingWhatsApp` counts any sale
   * with `whatsapp_owner_sent = 0` as still owed, so an empty Owner number
   * would hold the "N bills not sent" chip above zero permanently.
   */
  it('rejects blank with an explanation of what it would cost', () => {
    expect(validateOwnerWhatsAppNumber('')).toMatch(/queued as undelivered/)
    expect(validateOwnerWhatsAppNumber('   ')).toMatch(/queued as undelivered/)
  })

  it('rejects a number that is not a plausible mobile', () => {
    expect(validateOwnerWhatsAppNumber('12345')).toMatch(/10-digit mobile number/)
  })
})

describe('validateFullName', () => {
  it('accepts a name and rejects blank or overlong', () => {
    expect(validateFullName('Anil Kumar')).toBeNull()
    expect(validateFullName(' ')).toMatch(/required/)
    expect(validateFullName('x'.repeat(61))).toMatch(/60 characters or fewer/)
  })
})

describe('validateUsername', () => {
  it('accepts lowercase letters, digits, dot, dash and underscore', () => {
    expect(validateUsername('anil')).toBeNull()
    expect(validateUsername('anil.kumar_2-b')).toBeNull()
  })

  /**
   * `verifyLogin` matches `users.username` exactly, so a capital letter typed
   * once at creation becomes a login the person can never reproduce.
   */
  it('rejects uppercase, spaces and other punctuation', () => {
    expect(validateUsername('Anil')).toMatch(/lowercase/)
    expect(validateUsername('anil kumar')).toMatch(/lowercase/)
    expect(validateUsername('anil@shop')).toMatch(/lowercase/)
  })

  it('rejects blank and enforces the length bounds', () => {
    expect(validateUsername('')).toMatch(/required/)
    expect(validateUsername('ab')).toMatch(/between 3 and 32/)
    expect(validateUsername('a'.repeat(33))).toMatch(/between 3 and 32/)
    expect(validateUsername('a'.repeat(32))).toBeNull()
  })
})

describe('validatePassword', () => {
  it('accepts six characters or more', () => {
    expect(validatePassword('sales123')).toBeNull()
    expect(validatePassword('abcdef')).toBeNull()
  })

  it('rejects blank and anything shorter than six', () => {
    expect(validatePassword('')).toMatch(/required/)
    expect(validatePassword('abcde')).toMatch(/at least 6/)
  })
})
