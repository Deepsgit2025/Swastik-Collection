# PHASE5.md — Sale Screen (Core POS Flow)

> Self-contained. Assumes Phases 1–4 complete: auth/permissions, full schema, Parties module (including `quickAddParty` and `adjustPartyBalance`), and the barcode scanner hook all working. Read CLAUDE.md first.

## 0. What This Phase Is For

The main billing screen — where both Owner and Salesman spend most of their time. **No stock/inventory tracking of any kind** — items are billed by manual entry or barcode scan, quantity and price only, there is no stock count anywhere to validate against or deduct from. This app permanently has no inventory module.

Note: this phase builds the sale **creation** flow up through saving the sale record. It does **not** yet include the WhatsApp send-gate (Phase 6) or the print button (Phase 7) — those attach to this screen in the next two phases. For this phase, "completing" a sale means it's saved to the database; printing is deliberately blocked/stubbed until Phase 6/7 land, so don't build a working print button here even as a placeholder that actually prints.

## 1. Screen Layout (`/sale/new`)

- Item entry area:
  - Barcode scan input (uses Phase 4's `useBarcodeScanner` hook) — scanning a known `barcode_value` from `barcode_labels` auto-adds it as a line item
  - Manual item search/add (by name, for items without a generated barcode, or a shop that doesn't label everything)
  - Each cart line: item name, quantity (editable), unit price (editable — **both roles can override price**, per the confirmed decision), **discount (compulsory field, always visible, defaults to 0, never hidden or optional)**, computed line total
- Cart totals area: subtotal, total discount, grand total
- Party selection: search existing party or trigger Phase 3's quick-add modal inline; required only if payment mode is Credit or Split-with-credit, optional for pure Cash/UPI
- Payment section:
  - Mode selector: Cash / UPI / Credit / Split
  - If Split: two amount fields (Cash amount, UPI amount) that must sum to the grand total — validate this before allowing save
  - If Credit or Split-with-credit-component: party is required, and the credit portion is added to `parties.balance` via `adjustPartyBalance` on save
- "Complete Sale" button — saves the sale, sale_items, and (if applicable) adjusts party balance. Does **not** print (that's Phase 7) and does **not** yet require WhatsApp confirmation (Phase 6 — for this phase, just get the save working end-to-end)

## 2. Data Writes on "Complete Sale"

New backend function: `createSale(user, {partyId, items, paymentMode, cashAmount, upiAmount, creditAmount})`, calling `assertPermission(user.role, 'sale:create')` first (already allowed for both roles per Phase 2's table).

Steps inside `createSale`:
1. Validate: sum of `items[].lineTotal` matches `subtotal`; `cashAmount + upiAmount + creditAmount` equals `grandTotal`; if `creditAmount > 0`, `partyId` is required
2. Compute `is_cash_bill` = true only if `creditAmount === 0` (per the retention rule in CLAUDE.md — a bill with any credit component is never subject to the 30/60/90 cash-bill purge, it's tracked until cleared instead)
3. Compute `purge_at` = `created_at + 90 days` (populate even though nothing acts on it until Phase 12, per Phase 2's note)
4. Insert into `sales`, then insert each line into `sale_items` (each row must include `discount`, never omitted)
5. If `creditAmount > 0`, call `adjustPartyBalance(partyId, +creditAmount)` from Phase 3
6. Return the created sale's full record (needed by Phase 6 to generate the WhatsApp bill content)

## 3. Discount and Split-Payment Validation Rules

- `discount` on a line item cannot exceed `quantity * unit_price` for that line (can't discount below zero) — validate client-side and again in `createSale` server-side, don't trust the UI alone
- Split payment: `cash_amount + upi_amount + credit_amount` must exactly equal `grand_total` — block save with a clear inline error if they don't add up, don't silently round or adjust

## 4. Permission Wiring

| Action | Owner | Salesman |
|---|---|---|
| Create a sale | ✅ | ✅ |
| Override item price during sale | ✅ | ✅ |
| Apply discount | ✅ | ✅ |
| Quick-add party mid-sale | ✅ | ✅ (via Phase 3's `quickAddParty`) |

No edit/delete of a sale after creation exists in this phase — that's Owner-only functionality that isn't built until it's needed (not currently in any phase spec as a dedicated screen; if the client wants post-sale editing, that's a scope addition to flag, not something to build speculatively now).

## 5. Explicitly Out of Scope This Phase

- WhatsApp send/gate logic (Phase 6) — do not wire up any WhatsApp code yet
- Print button functionality (Phase 7) — the button can exist in a disabled state as a visual placeholder for where Phase 6/7 will attach, but should not perform any print action yet
- GST/tax — never in scope, permanently
- Any stock/inventory check or deduction — never in scope, permanently

## 6. Acceptance Criteria

1. A cash sale (no party) with a single item, no discount, saves correctly and appears in `sales`/`sale_items`
2. A credit sale correctly requires a party, and on save increases that party's `balance` by the credit amount (verify against Phase 3's ledger view)
3. A split payment sale (e.g. ₹500 cash + ₹300 UPI, no credit) saves with both amounts recorded correctly, and `is_cash_bill = true` (since no credit component)
4. A split payment sale that includes a credit component (e.g. ₹200 cash + ₹300 credit) sets `is_cash_bill = false` and still requires and links a party
5. A line item discount reduces that line's total correctly and cannot be entered as a value exceeding the line's pre-discount amount
6. Scanning a known barcode (from Phase 4 test labels) auto-adds the correct item to the cart with the right price
7. Both Owner and Salesman can complete a sale end-to-end; Salesman can override price and apply discount just like Owner
8. A sale where `cash_amount + upi_amount + credit_amount` doesn't equal `grand_total` is rejected with a clear inline error before it reaches `createSale`

## 7. Prompts for Claude Code

**Prompt 1 — Sale Screen Layout**
```
Read PHASE5.md fully and CLAUDE.md for permanent rules — note especially: no inventory/stock tracking ever, discount is a compulsory line-item field, split payment is required, and both roles can override price. Build the sale screen layout per section 1: item entry (manual + barcode scan via Phase 4's useBarcodeScanner hook), cart with editable quantity/price/discount per line, party selection using Phase 3's quick-add modal, and the payment mode section including split payment fields. Leave the print button visually present but disabled/non-functional — that's Phase 6/7's job, not this one.
```

**Prompt 2 — createSale Backend**
```
Implement createSale per section 2, including all the validation in section 3 (discount can't exceed line pre-discount total, split amounts must sum exactly to grand total). Make sure is_cash_bill and purge_at are computed and populated correctly even though nothing consumes them until Phase 12. Wire in adjustPartyBalance from Phase 3 for the credit-amount case.
```

**Prompt 3 — Verify**
```
Go through PHASE5.md section 6 acceptance criteria one by one, including testing the barcode scan-to-cart flow with a real label printed and scanned via Phase 4's hardware, and confirming a mismatched split-payment total is rejected before it reaches the database.
```
