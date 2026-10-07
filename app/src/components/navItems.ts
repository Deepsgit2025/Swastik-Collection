export interface NavItem {
  label: string
  to: string
}

/**
 * One list, not a per-role record.
 *
 * It was keyed by role until 2026-08-27, when the salesman login was removed,
 * and carried a `requiresOwner` flag (a lock glyph) from then until 2026-09-19,
 * when the Owner lock on screens was removed: every screen opens straight away
 * now, and it is the *actions* on them - edit, delete, save settings - that ask
 * for the Owner password, at the moment they are clicked.
 */
export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard' },
  { label: 'New Sale', to: '/sale/new' },
  { label: 'Payment In', to: '/payment-in' },
  { label: 'Parties', to: '/parties' },
  { label: 'Expenses', to: '/expenses' },
  // The day/week/month bill list by customer, amount and salesman.
  { label: 'Sales', to: '/sales' },
  { label: 'Reports', to: '/reports' },
  { label: 'Barcode Generator', to: '/barcode-generator' },
  { label: 'Connect WhatsApp', to: '/whatsapp' },
  { label: 'Settings', to: '/settings' },
]
