// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toWhatsAppNumber } from './phone.ts'

describe('toWhatsAppNumber', () => {
  it('prepends the default country code to a bare 10-digit Indian mobile number', () => {
    expect(toWhatsAppNumber('9644570828')).toBe('919644570828')
  })

  it('strips spaces/dashes/parens before checking length', () => {
    expect(toWhatsAppNumber('96445 70828')).toBe('919644570828')
    expect(toWhatsAppNumber('+91 96445-70828')).toBe('919644570828')
  })

  it('leaves a number that already carries a country code untouched', () => {
    expect(toWhatsAppNumber('919644570828')).toBe('919644570828')
  })

  it('leaves an already-normalized number untouched (idempotent)', () => {
    expect(toWhatsAppNumber(toWhatsAppNumber('9644570828'))).toBe('919644570828')
  })
})
