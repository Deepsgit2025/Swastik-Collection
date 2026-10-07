# PLAN.md — Windows Billing App (Vyapar Replacement)

## 1. Project Summary

A Windows desktop billing app for a retail/wholesale shop currently using Vyapar. No purchase module, no inventory/stock management — this is a **billing, payments, parties, and reporting** tool only. Two roles: **Owner** (full access) and **Salesman** (sale + print label only, no edit/delete anywhere).

Core rule that shapes the whole app: **every sale must be sent via WhatsApp Web to both the customer and the owner before the bill can be printed.**

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron | Native Windows app, packages as `.exe`, full filesystem/USB access for barcode/label printer |
| UI | React + TypeScript | Component reuse across Owner/Salesman views, fast iteration |
| Local DB | SQLite (via `better-sqlite3`) | Offline-first, single-file, no server needed, easy backup |
| WhatsApp | `whatsapp-web.js` (Puppeteer-driven WhatsApp Web session) | Matches Vyapar's own approach; no WhatsApp Business API approval needed |
| Barcode generation | `bwip-js` or `jsbarcode` | Generates Code128/EAN13 for self-printed labels |
| Barcode scanning | USB keyboard-wedge input (treated as fast keystrokes + Enter) | No special driver needed; works with 95% of cheap scanners |
| Label/bill printing | Windows print spooler via Electron `webContents.print()`, or raw ESC/POS if thermal | Confirm hardware in Phase 4 |
| Backup/Sync | Google Drive API (OAuth2, `googleapis` npm package) | Push SQLite snapshot + attachments on schedule |
| Packaging | `electron-builder` | Produces signed Windows installer |

## 3. Roles & Permission Model (enforced at data-access layer, not just UI)

**Owner**
- Full CRUD on Parties, Expenses, Settings
- View all reports (own + salesman-wise)
- Edit/delete/void any sale or payment
- Manage users (create/disable salesman logins)
- Configure WhatsApp connection, Google Drive backup, label templates
- Override print-gate if WhatsApp send fails

**Salesman**
- Create a new sale (with WhatsApp-gated print)
- Record Payment-In against a sale/party
- Quick-add a new customer (name + phone only) mid-sale
- Generate/print barcode labels
- View own day's sales total (cash/UPI split) — **not** other salesmen's numbers
- **Cannot**: edit or delete any sale, payment, party, or expense; cannot access Settings, Reports (beyond own daily total), or Backup

This permission table is enforced twice: UI hides the controls, and the local API layer rejects the action even if called directly — so a modified frontend can't bypass it.

## 4. Confirmed Decisions (locked in with client)

1. **GST/tax fields on bill**: **Not required.** No tax module, no tax fields on sale/bill.
2. **Split payment (part cash + part UPI on one sale)**: **Required.** Sale screen must support splitting a single sale's payment across Cash and UPI.
3. **Salesman price override during sale**: **Allowed.** Salesman can edit the per-line price at time of sale. A **Discount column is compulsory** on every sale line item (not optional, not just an Owner-only field) — applies whether Owner or Salesman is billing.
4. **Payment-In receipt WhatsApp-gated like a sale**: **Not required.** Payment-In is a simple record-and-done flow — no WhatsApp send/print gate on it (unlike the Sale flow in Phase 6/7).
5. **Salesman can log expenses**: **Allowed.** Expenses module is accessible to Salesman, not Owner-only (revise Phase 9 permissions accordingly).
6. **Hardware — confirmed real models**:
   - Label/receipt printer: **Posiflow ShipPro (4-inch)** — USB/Bluetooth thermal label + receipt printer.
   - Barcode scanner: **Helett HT410** — wired USB, plug-and-play, keyboard-wedge/HID, no driver required, supports suffix settings (can be configured to send Enter/Tab after each scan) — confirms the Phase 1 scanner-integration assumption exactly as planned.
   - Print pipeline note for Phase 4/7: the ShipPro is USB-driver compatible with Windows, so the default Windows print dialog path works: but 4-inch thermal label printers often print more reliably (correct alignment/DPI) via direct ESC/POS or label-format commands rather than the generic Windows print spooler. Phase 4 should build the driver-based path first and keep an ESC/POS fallback in mind if label alignment/quality is an issue in testing.
7. **Retention rule — finalized, replaces the earlier soft-delete/archive assumption**:
   - Cash bills live in **local storage for 30 days**, then move to being **only in the Google Drive backup for a further 60 days** (90 days total from creation), then are **permanently deleted — poof, gone, not recoverable**. No pre-purge snapshot is kept.
   - Credit sales are retained indefinitely, regardless of age, until the balance is fully cleared — unaffected by the 30/60-day cash-bill rule.
   - This is a genuine hard-delete at day 90, not an archive. Flagged once for the client's awareness (permanent deletion of financial records can have tax-retention implications) — client has confirmed this is the intended behavior, no further sign-off needed.

---

## Phase 1 — Project Scaffolding & Auth

**Goal:** Empty but running Electron+React app with role-based login working end-to-end.

- Set up Electron + React + TypeScript + Vite build pipeline
- Set up `better-sqlite3` with a migrations runner
- Build `users` table (Owner/Salesman), bcrypt password hashing
- Login screen → role-based route guard (Owner sees full nav, Salesman sees restricted nav)
- Basic app shell: sidebar nav, top bar, empty dashboard placeholder

**Acceptance criteria:**
- App launches as a packaged `.exe` on a clean Windows machine
- Owner and Salesman accounts log in and land on different nav sets
- Salesman cannot navigate (via URL/route hack) into Owner-only screens

---

## Phase 2 — Database Schema & Core Data Layer

**Goal:** Full schema in place (see SCHEMA.md), with a data-access layer that enforces role permissions server-side (in-process, since this is local).

- Implement all tables: `users`, `parties`, `sales`, `sale_items`, `payments`, `expenses`, `settings`, `whatsapp_log`, `barcode_labels`, `backup_log`
- Build a permission-checking wrapper around every write operation (`canEdit(user, resource)`)
- Seed script for testing (dummy parties, one Owner, one Salesman)

**Acceptance criteria:**
- Every write function rejects a Salesman attempting edit/delete, with a clear error, independent of UI state
- Schema matches SCHEMA.md exactly; migrations run cleanly on first launch

---

## Phase 3 — Parties Module

**Goal:** Customer/supplier-equivalent contact management (parties only — no supplier/purchase logic since there's no purchase module).

- Party list (search, filter by balance due)
- Add/Edit party (Owner full form; Salesman gets quick-add: name + phone only, during sale flow)
- Party ledger view: running balance, linked sales, linked payments
- Party balance shown on dashboard and in sale screen (for credit sales)

**Acceptance criteria:**
- Owner can fully edit any party; Salesman can only create (not edit) via quick-add
- Party ledger balance recalculates correctly against sales/payments

---

## Phase 4 — Barcode: Generation + Scanning + Label Printing

**Goal:** Self-serve barcode label generation and printing, plus scan-to-add-item in the sale screen.

- Barcode generator screen: input product name/price/code → generate Code128/EAN13 → print label (batch printing supported)
- Label template settings (size, fields shown — name/price/code)
- Scanner integration: listen for rapid keystroke+Enter pattern in sale screen, auto-lookup matching code, add to cart
- **Confirm hardware assumption from client here before building print pipeline**

**Acceptance criteria:**
- A label printed from the app scans correctly back into the sale screen
- Batch label printing (e.g., 50 labels for one SKU) works without spooler errors

---

## Phase 5 — Sale Screen (Core POS Flow) — No Inventory Deduction

**Goal:** The main billing screen. No stock tracking — items are billed by manual entry or barcode scan, quantity and price only, no stock count validation.

- Cart-style sale screen: scan/search item, quantity, price (editable per line — Salesman is allowed to override price)
- **Discount column on every line item — compulsory field, not optional**, factored into line total and sale total
- Party selection (existing or quick-add) — required for credit sale, optional for cash
- Payment mode: Cash / UPI / Credit (credit requires a party), **with split payment support** (e.g. part Cash + part UPI on a single sale)
- Sale total calculation: quantity × price − discount, summed, with the cash/UPI split (if used) tracked per sale for reporting
- No tax/GST fields — out of scope

**Acceptance criteria:**
- A full sale can be created, from item entry to payment mode selection, without touching any inventory table
- Every line item requires a discount value (defaults to 0, but the field cannot be removed/hidden) and it correctly reduces the line and sale totals
- A split payment (e.g. ₹500 cash + ₹300 UPI on one sale) saves correctly and reports correctly against both totals
- Credit sale correctly creates/updates a party balance

---

## Phase 6 — WhatsApp Web Gate (Critical Path)

**Goal:** Implement the core business rule: **no print until WhatsApp send succeeds to both customer and Owner.**

- WhatsApp Web session connect screen (QR scan, session persistence so it doesn't need re-scanning every launch)
- On sale completion: auto-generate a bill (PDF/image), send to customer's WhatsApp number and to Owner's configured number
- Print button stays disabled/greyed until both sends confirm delivery (or Owner override is used)
- WhatsApp send log (`whatsapp_log` table) for auditing — success/failure per sale, per recipient
- Owner override toggle: allows print without WhatsApp confirmation, logged as an override event

**Acceptance criteria:**
- Attempting to print before WhatsApp sends succeed is blocked with a clear message
- Both customer and Owner receive the bill via WhatsApp Web in a live test
- Override path works, is Owner-only, and is logged

---

## Phase 7 — Bill Printing

**Goal:** Printable bill layout, gated by Phase 6.

- Bill template (shop name/header, items, totals, payment mode, party name if credit)
- Print via Windows print dialog (or raw ESC/POS if thermal — pending hardware confirmation)
- Re-print capability for Owner only (Salesman cannot re-print past bills, only the just-completed one)

**Acceptance criteria:**
- Printed bill layout matches client's reference screenshots in structure
- Salesman can print only the current, just-WhatsApp-sent bill — no access to reprint historical bills

---

## Phase 8 — Payment In

**Goal:** Record payments against outstanding credit balances, independent of a new sale.

- Payment-In screen: select party, enter amount, mode (Cash/UPI), optional note
- Auto-updates party balance and shows updated ledger
- **No WhatsApp gate on Payment-In** — record-and-done, unlike the Sale flow in Phase 6/7

**Acceptance criteria:**
- Recording a payment against a party correctly reduces their outstanding balance
- Payment history shows on party ledger with date/mode/amount
- Payment-In can be saved with no WhatsApp send required, confirming it's not blocked by the Phase 6 gate logic

---

## Phase 9 — Expenses Module

**Goal:** Simple expense logging. **Salesman has access to log expenses** (revised from the earlier Owner-only assumption); Owner retains edit/delete rights, Salesman can only add.

- Expense entry: category, amount, date, note — accessible to both Owner and Salesman
- Expense list with date-range filter (Salesman sees the list to avoid duplicate entries, but per the global permission rule cannot edit/delete any expense, including their own once saved)
- Expense total shown on dashboard (Owner view — full total; Salesman dashboard shows only their own day's sales per Phase 10, expenses are not part of the Salesman dashboard)

**Acceptance criteria:**
- Salesman nav has an Expenses entry, can add a new expense, but has no edit/delete controls anywhere on the screen
- Attempting to edit/delete an expense as Salesman via a direct API call is rejected by the Phase 2 permission layer
- Expense totals correctly roll into daily/monthly Owner reports regardless of which role logged them

---

## Phase 10 — Dashboard

**Goal:** At-a-glance daily numbers, role-aware.

- **Owner dashboard**: today's total sales, cash vs UPI split, salesman-wise breakdown, outstanding credit total, expense total, quick links
- **Salesman dashboard**: today's own sales total, own cash vs UPI split only

**Acceptance criteria:**
- Numbers match the underlying sales/payments tables exactly for the selected day
- Salesman dashboard never surfaces another salesman's figures

---

## Phase 11 — Reports

**Goal:** Daily and historical reporting, Owner-only (Salesman gets only their own-day summary from the dashboard, not this module).

- Daily Sales Report: date-range picker, total sales, cash/UPI split, credit issued, credit collected
- Salesman-wise Sales Report: per-salesman totals for a selected range, drill into individual sales
- Export to PDF/Excel for sharing with accountant
- Party outstanding report (who owes what, as of today)

**Acceptance criteria:**
- Salesman-wise report correctly attributes every sale to the logged-in salesman who created it
- Exported PDF/Excel matches on-screen totals exactly

---

## Phase 12 — Settings, Backup/Sync, and Retention Rules

**Goal:** Owner-only configuration hub, plus the Google Drive backup and the cash-bill auto-vanish rule.

- **Settings**: shop details/header for bills, WhatsApp number config, label template, tax/GST toggle, user management (create/disable Salesman logins), backup schedule
- **Google Drive backup**: scheduled push of SQLite DB snapshot + generated bill PDFs; manual "Backup Now" button; restore flow (Owner-only, requires confirmation)
- **Retention rule engine (finalized — hard delete, not archive)**:
  - Day 0–30: cash bill lives in local SQLite storage, fully visible/active.
  - Day 30: removed from local storage, but remains present in Google Drive backup snapshots.
  - Day 30–90: cash bill exists **only** in Google Drive backup, not locally.
  - Day 90: **permanently deleted** from Google Drive backup as well — no copy retained anywhere, not recoverable.
  - Credit sales: retained indefinitely until fully cleared (balance = 0), regardless of age — entirely unaffected by the above.
  - This requires a scheduled job (daily, e.g. on app launch or a background timer) that (a) moves eligible local cash bills out of local storage at day 30, keeping them only in the next Drive sync, and (b) purges anything past day 90 from Drive itself via the Drive API delete call.
- Manual data export (CSV) for accountant handoff, independent of the 30/60/90-day cycle — Owner should be encouraged/reminded to export anything they need to keep past day 90, since deletion at that point is final

**Acceptance criteria:**
- A cash bill created 31+ days ago with no credit balance is gone from local active sale lists, but is still retrievable from the Google Drive backup
- A cash bill created 91+ days ago is not present locally or in the Drive backup — confirmed by inspecting the Drive folder directly
- A credit sale older than 90 days remains fully visible and editable-by-Owner until cleared, unaffected by the purge job
- Google Drive restore correctly rebuilds the local DB from a chosen backup point (for anything still within its 90-day life)

---

## Open Questions — Resolved

All prior open questions are now answered and folded into the relevant phases above (Section 4 has the full list). Nothing outstanding before development starts on Phases 1–2. One item worth a final gut-check with the client before Phase 12 ships: the day-90 Google Drive purge is a genuine, non-recoverable hard delete — worth one more explicit confirmation from them in writing before that job goes live in production, purely so there's no "wait, it's actually gone?" moment down the line.

---

## Suggested Build Order for Claude Code

Phases 1 → 2 → 3 are foundational and sequential. Phases 4 and 5 can be built in parallel once Phase 2 is done (barcode module doesn't depend on the sale screen, but the sale screen needs barcode scan-to-add by Phase 5's acceptance criteria, so land Phase 4 first). Phase 6 (WhatsApp gate) must land before Phase 7 (print) since print depends on it. Phases 8–11 are independent of each other and can be parallelized. Phase 12 (Settings/Backup/Retention) should be last since it touches data created by every other module.