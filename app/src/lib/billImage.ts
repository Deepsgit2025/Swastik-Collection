import type { SaleRecord } from '../types/sale.ts'
import { formatCurrency, formatDate } from './format.ts'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Standalone HTML document for the post-sale WhatsApp bill image
 * (electron/whatsapp/billImage.ts renders this to a PNG via a hidden
 * BrowserWindow). Supersedes the v1 plain-text `buildBillMessage` per
 * PHASE6.md section 2's own note that a rendered image was a likely
 * follow-up once the client saw plain text — this is the client-approved
 * design (coral header, info chips, item rows, bold total banner).
 *
 * No external resources (no Google Fonts, no remote images) — this is a
 * local-first desktop app, and electron-builder.yml has no font-bundling
 * story, so the font stack is system fonts only.
 */
export function buildBillImageHtml(
  sale: SaleRecord,
  partyName: string | null,
  businessName: string,
  businessPhone: string,
): string {
  const accent = '#ff6b4a'
  const isPaidInFull = sale.credit_amount === 0
  const received = sale.cash_amount + sale.upi_amount
  const customerName = partyName ?? 'Walk-in Customer'

  const pillIcon = isPaidInFull
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.6" fill="#ffffff" stroke="none"/></svg>'
  const pillLabel = isPaidInFull ? 'Paid in full' : `Balance ${formatCurrency(sale.credit_amount)} due`

  const itemRows = sale.items
    .map(
      (item) => `
      <div style="display:flex;flex-direction:row;justify-content:space-between;align-items:center;background:#f1efe9;border-radius:14px;padding:14px 18px;">
        <div>
          <div style="font-size:15px;font-weight:700;">${escapeHtml(item.item_name)}</div>
          <div style="font-size:12px;color:#8a857a;margin-top:2px;">Qty ${item.quantity} × ${formatCurrency(item.unit_price)}</div>
        </div>
        <div style="font-family:'Segoe UI Semibold',-apple-system,'Segoe UI',Roboto,sans-serif;font-weight:700;font-size:16px;">${formatCurrency(item.line_total)}</div>
      </div>`,
    )
    .join('')

  // Only when a discount was actually given: a zero-discount bill keeps its
  // original layout, and an empty string adds no flex child (so no extra gap).
  const totalsBlock =
    sale.total_discount > 0
      ? `
    <div style="display:flex;flex-direction:column;gap:6px;padding:0 4px;font-size:14px;color:#5b574f;">
      <div style="display:flex;flex-direction:row;justify-content:space-between;"><span>Subtotal</span><span>${formatCurrency(sale.subtotal)}</span></div>
      <div style="display:flex;flex-direction:row;justify-content:space-between;"><span>Discount</span><span style="font-weight:700;color:#1e8a4c;">− ${formatCurrency(sale.total_discount)}</span></div>
    </div>
`
      : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1e1c1a; background: #fbfaf7; }
</style>
</head>
<body>
<div style="width:480px;box-sizing:border-box;background:#fbfaf7;">

  <div style="background:${accent};padding:30px 34px;display:flex;flex-direction:row;justify-content:space-between;align-items:flex-start;">
    <div style="flex:1;min-width:0;padding-right:16px;">
      <div style="font-weight:800;font-size:22px;line-height:1.25;color:#ffffff;">${escapeHtml(businessName)}</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.8);margin-top:4px;">${escapeHtml(businessPhone)}</div>
    </div>
    <div style="background:rgba(255,255,255,0.18);border-radius:999px;padding:8px 14px;display:flex;flex-direction:row;align-items:center;gap:6px;flex-shrink:0;">
      ${pillIcon}
      <span style="color:#ffffff;font-size:12px;font-weight:700;white-space:nowrap;">${pillLabel}</span>
    </div>
  </div>

  <div style="padding:30px 34px;display:flex;flex-direction:column;gap:24px;">

    <div style="display:flex;flex-direction:row;gap:10px;">
      <div style="background:#f1efe9;border-radius:14px;padding:10px 16px;flex:1;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#8a857a;">Invoice</div>
        <div style="font-weight:700;font-size:15px;margin-top:2px;">#${sale.id}</div>
      </div>
      <div style="background:#f1efe9;border-radius:14px;padding:10px 16px;flex:1;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#8a857a;">Date</div>
        <div style="font-weight:700;font-size:15px;margin-top:2px;">${formatDate(sale.created_at)}</div>
      </div>
      <div style="background:#f1efe9;border-radius:14px;padding:10px 16px;flex:1;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#8a857a;">Customer</div>
        <div style="font-weight:700;font-size:15px;margin-top:2px;">${escapeHtml(customerName)}</div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:10px;">
      ${itemRows}
    </div>
${totalsBlock}
    <div style="background:${accent};border-radius:16px;padding:18px 22px;display:flex;flex-direction:row;justify-content:space-between;align-items:center;">
      <span style="color:#ffffff;font-size:14px;font-weight:600;">Total amount</span>
      <span style="color:#ffffff;font-weight:800;font-size:24px;">${formatCurrency(sale.grand_total)}</span>
    </div>

    <div style="font-size:13px;color:#8a857a;">Received ${formatCurrency(received)}</div>

    <div style="text-align:center;padding-top:6px;">
      <div style="font-weight:700;font-size:16px;color:${accent};">Thank you for shopping with us!</div>
    </div>
  </div>
</div>
</body>
</html>`
}

/** Short WhatsApp caption sent alongside the image — the itemized detail lives in the image itself. */
export function buildBillCaption(sale: SaleRecord, businessName: string): string {
  return `Thank you for shopping with ${businessName}! 🙏\nBill #${sale.id} — ${formatCurrency(sale.grand_total)}`
}
