// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildBillCaption, buildBillImageHtml } from './billImage.ts'
import { formatCurrency, formatDate } from './format.ts'
import type { SaleRecord } from '../types/sale.ts'

function baseSale(overrides: Partial<SaleRecord> = {}): SaleRecord {
  return {
    id: 42,
    party_id: null,
    salesman_user_id: 1,
    // Who was at the terminal vs. who sold it — separate since 2026-08-27.
    salesman_id: 1,
    payment_mode: 'cash',
    cash_amount: 500,
    upi_amount: 0,
    credit_amount: 0,
    subtotal: 500,
    total_discount: 0,
    grand_total: 500,
    whatsapp_customer_sent: 0,
    whatsapp_owner_sent: 0,
    printed: 0,
    print_override_used: 0,
    is_cash_bill: 1,
    archived_local: 0,
    purge_at: null,
    created_at: '2026-08-23 10:00:00',
    items: [{ id: 1, sale_id: 42, item_name: 'Cotton Saree', barcode: null, quantity: 1, unit_price: 500, line_total: 500 }],
    ...overrides,
  }
}

describe('buildBillImageHtml', () => {
  it('includes the business name, phone, invoice number, and formatted date', () => {
    const html = buildBillImageHtml(baseSale(), null, 'Shree Swastik Collections', '9644570828')
    expect(html).toContain('Shree Swastik Collections')
    expect(html).toContain('9644570828')
    expect(html).toContain('#42')
    expect(html).toContain(formatDate('2026-08-23 10:00:00'))
  })

  it('includes each item name, quantity, unit price, and line total', () => {
    const html = buildBillImageHtml(baseSale(), null, 'Shop', '000')
    expect(html).toContain('Cotton Saree')
    expect(html).toContain('Qty 1')
    expect(html).toContain(formatCurrency(500))
  })

  it('shows a "Paid in full" pill and the full grand total as received when there is no credit component', () => {
    const html = buildBillImageHtml(baseSale(), null, 'Shop', '000')
    expect(html).toContain('Paid in full')
    expect(html).toContain(`Received ${formatCurrency(500)}`)
  })

  it('shows a balance-due pill and only the cash+UPI portion as received when the sale has a credit component', () => {
    const sale = baseSale({
      payment_mode: 'split',
      cash_amount: 200,
      upi_amount: 100,
      credit_amount: 200,
      grand_total: 500,
    })
    const html = buildBillImageHtml(sale, 'Sunita Fabrics', 'Shop', '000')
    expect(html).not.toContain('Paid in full')
    expect(html).toContain(`Balance ${formatCurrency(200)} due`)
    expect(html).toContain(`Received ${formatCurrency(300)}`)
  })

  it('shows the party name when given, and falls back to "Walk-in Customer" when not', () => {
    const withParty = buildBillImageHtml(baseSale(), 'Sunita Fabrics', 'Shop', '000')
    expect(withParty).toContain('Sunita Fabrics')

    const withoutParty = buildBillImageHtml(baseSale(), null, 'Shop', '000')
    expect(withoutParty).toContain('Walk-in Customer')
  })

  it('shows the subtotal and the discount when a discount was given, so the Owner and the customer can both see it', () => {
    const html = buildBillImageHtml(
      baseSale({ subtotal: 525, total_discount: 25, grand_total: 500 }),
      null,
      'Shop',
      '000',
    )
    expect(html).toContain('Subtotal')
    expect(html).toContain('Discount')
    expect(html).toContain(formatCurrency(525))
    expect(html).toContain(formatCurrency(25))
  })

  it('leaves the discount block out entirely when there is no discount', () => {
    const html = buildBillImageHtml(baseSale(), null, 'Shop', '000')
    expect(html).not.toContain('Subtotal')
    expect(html).not.toContain('Discount')
  })

  it('escapes item names so a stray "<" or "&" cannot break the HTML', () => {
    const sale = baseSale({
      items: [{ id: 1, sale_id: 42, item_name: 'A & B <Tag>', barcode: null, quantity: 1, unit_price: 500, line_total: 500 }],
    })
    const html = buildBillImageHtml(sale, null, 'Shop', '000')
    expect(html).toContain('A &amp; B &lt;Tag&gt;')
    expect(html).not.toContain('A & B <Tag>')
  })
})

describe('buildBillCaption', () => {
  it('includes the business name, bill number, and grand total', () => {
    const caption = buildBillCaption(baseSale({ grand_total: 500 }), 'Shree Swastik Collections')
    expect(caption).toContain('Shree Swastik Collections')
    expect(caption).toContain('#42')
    expect(caption).toContain(formatCurrency(500))
  })
})
