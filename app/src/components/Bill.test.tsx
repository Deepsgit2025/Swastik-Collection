import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Bill } from './Bill.tsx'
import type { ShopSettings } from '../types/settings.ts'
import type { SaleRecord } from '../types/sale.ts'

/** Stands in for the `settings` rows `BillPrintSheet` fetches — deliberately not the real shop's values, so a header that ignored the prop would fail rather than coincidentally pass. */
const SHOP: ShopSettings = {
  shopName: 'Test Shop Name',
  shopAddress: '9 Test Lane, Testville',
  shopPhone: '9000000001',
  ownerWhatsappNumber: '919000000002',
}

function makeSale(overrides: Partial<SaleRecord> = {}): SaleRecord {
  return {
    id: 7,
    party_id: null,
    salesman_user_id: 1,
    // Who was at the terminal vs. who sold it — separate since 2026-08-27.
    salesman_id: 1,
    payment_mode: 'cash',
    cash_amount: 175,
    upi_amount: 0,
    credit_amount: 0,
    subtotal: 200,
    total_discount: 25,
    grand_total: 175,
    whatsapp_customer_sent: 1,
    whatsapp_owner_sent: 1,
    printed: 0,
    print_override_used: 0,
    is_cash_bill: 1,
    archived_local: 0,
    purge_at: null,
    created_at: '2026-01-01 10:00:00',
    items: [
      { id: 1, sale_id: 7, item_name: 'Cotton Saree', barcode: 'ABC123', quantity: 2, unit_price: 100, line_total: 200 },
    ],
    ...overrides,
  }
}

describe('Bill', () => {
  it('renders the shop header from the settings it is handed', () => {
    render(<Bill sale={makeSale()} shop={SHOP} />)
    expect(screen.getByText(SHOP.shopName)).toBeInTheDocument()
    expect(screen.getByText(SHOP.shopAddress)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(SHOP.shopPhone))).toBeInTheDocument()
  })

  // The address is the one optional shop field (PHASE12.md section 1) — an
  // Owner who hasn't filled it in should get no line at all, not a blank
  // centred gap between the name and the phone.
  it('omits the address line when the shop address is blank', () => {
    const { container } = render(<Bill sale={makeSale()} shop={{ ...SHOP, shopAddress: '' }} />)
    const header = container.querySelector('.items-center')!
    expect(header.querySelectorAll('p')).toHaveLength(2)
    expect(screen.getByText(SHOP.shopName)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(SHOP.shopPhone))).toBeInTheDocument()
  })

  it('renders bill id, item lines, and totals, with discount shown once at the bill level only', () => {
    render(<Bill sale={makeSale()} shop={SHOP} />)
    expect(screen.getByText('Bill #7')).toBeInTheDocument()
    expect(screen.getByText('Cotton Saree')).toBeInTheDocument()
    expect(screen.getByText(/2 x/)).toBeInTheDocument()
    expect(screen.getByText('Grand Total')).toBeInTheDocument()
    // Only the bill-level totals block should say "Discount" — sale_items has
    // no per-line discount field (see CLAUDE.md's bill-level-discount rule).
    expect(screen.getAllByText('Discount')).toHaveLength(1)
  })

  it('omits the customer line for a walk-in sale but shows it when a party is linked', () => {
    const { rerender } = render(<Bill sale={makeSale()} shop={SHOP} partyName={null} />)
    expect(screen.queryByText(/Customer:/)).not.toBeInTheDocument()

    rerender(<Bill sale={makeSale({ party_id: 3 })} shop={SHOP} partyName="Ramesh Kumar" />)
    expect(screen.getByText('Customer: Ramesh Kumar')).toBeInTheDocument()
  })

  it('shows the cash/UPI/credit breakdown for a split-payment sale', () => {
    const sale = makeSale({
      payment_mode: 'split',
      cash_amount: 100,
      upi_amount: 50,
      credit_amount: 25,
      is_cash_bill: 0,
    })
    render(<Bill sale={sale} shop={SHOP} />)
    expect(screen.getByText(/Payment: Split/)).toBeInTheDocument()
    expect(screen.getByText('Cash')).toBeInTheDocument()
    expect(screen.getByText('UPI')).toBeInTheDocument()
    expect(screen.getByText('Credit')).toBeInTheDocument()
  })

  it('hides the breakdown block entirely for a non-split sale', () => {
    render(<Bill sale={makeSale({ payment_mode: 'cash' })} shop={SHOP} />)
    expect(screen.getByText(/Payment: Cash/)).toBeInTheDocument()
    expect(screen.queryByText('Cash', { selector: 'span' })).not.toBeInTheDocument()
  })
})
