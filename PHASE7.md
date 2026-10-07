# PHASE7.md — Bill Printing

> Self-contained. Assumes Phases 1–6 complete: sale creation and the WhatsApp gate both working, with `whatsapp_customer_sent` / `whatsapp_owner_sent` / `print_override_used` all correctly populated. Read CLAUDE.md first.

## 0. What This Phase Is For

The actual, functional Print button — gated entirely by Phase 6's flags. This phase is intentionally small: most of the hard logic (the gate itself) was already built in Phase 6. This phase is about the print layout and making the gate visually/functionally real on the sale screen.

## 1. Bill Print Layout

- Shop header: shop name, address, phone (temporary hardcoded/config values for now — real Settings-driven header comes in Phase 12, note this clearly in code)
- Itemized list: item name, quantity, unit price, discount, line total
- Totals: subtotal, total discount, grand total
- Payment mode shown (Cash / UPI / Credit / Split — if split, show the cash/UPI breakdown)
- Party name shown if the sale is linked to one (especially important for credit sales)
- Sized appropriately for the Posiflow ShipPro 4-inch (same printer as Phase 4's labels — reuse whatever print-pipeline groundwork Phase 4 already established rather than building a second, different print path from scratch)

## 2. Wiring the Print Button to the Gate

On the sale screen (built in Phase 5, gate logic added in Phase 6):
- Print button is disabled by default immediately after a sale is created
- Becomes enabled the moment both `whatsapp_customer_sent` and `whatsapp_owner_sent` are true, **or** an Owner has used the override from Phase 6
- Clicking Print when enabled: renders the layout from section 1 and sends it to the printer, then sets `sales.printed = true`
- Clicking Print is blocked (button stays disabled, not just discouraged) any time neither condition is met — there is no way to reach the print action while the gate conditions are unmet, for any role

## 3. Reprint (Owner-Only)

- A separate reprint capability exists **only** for the Owner, reachable from a sale-history view (basic version — a simple list of past sales is enough for this phase; the full Reports module comes in Phase 11)
- Reprint does not re-trigger a WhatsApp send — it just reprints the already-generated bill layout for a sale that was already validly printed once
- Salesman has no reprint capability at all — not for their own sales, not for anyone else's; if a Salesman's printer jams or the paper runs out mid-print on the original attempt, only an Owner can help them get a second copy out

## 4. Permission Wiring

| Action | Owner | Salesman |
|---|---|---|
| Print the current, just-gated sale | ✅ | ✅ |
| Reprint any historical sale | ✅ | ❌ |

Add `sale:reprint` to the Phase 2 `PERMISSIONS` table if not already present (it was listed as a placeholder action in Phase 2's example table — confirm it's wired to real logic now).

## 5. Out of Scope This Phase

- Configurable bill template / shop header editor (Phase 12's Settings)
- Any changes to the WhatsApp gate logic itself — that's finished in Phase 6, this phase only consumes its output flags

## 6. Acceptance Criteria

1. Printed bill layout is legible and correctly sized on the real Posiflow ShipPro hardware, matching the client's original reference screenshots in overall structure (header, items, totals, payment mode)
2. Print button is provably unreachable (disabled, not just visually de-emphasized) until both WhatsApp flags are true or an override was used — test by attempting to trigger the print action directly (not just clicking the disabled button) and confirming it's rejected
3. A completed, printed sale correctly sets `sales.printed = true`
4. Owner can reprint any past sale from the basic sale-history list; Salesman has no reprint UI and a direct backend call to reprint as Salesman is rejected by `assertPermission`
5. Reprinting does not create duplicate `whatsapp_log` rows or re-trigger any WhatsApp send

## 7. Prompts for Claude Code

**Prompt 1 — Print Layout**
```
Read PHASE7.md fully and CLAUDE.md for permanent rules. Build the bill print layout per section 1, sized for the Posiflow ShipPro 4-inch — reuse the print pipeline groundwork from Phase 4's label printing rather than building a separate path. Use temporary hardcoded shop header values for now, clearly commented for Phase 12 to replace with real Settings data.
```

**Prompt 2 — Gate Wiring**
```
Wire the Print button on the sale screen to Phase 6's whatsapp_customer_sent / whatsapp_owner_sent flags and the override flag, per section 2. The button must be genuinely disabled/unreachable when the gate conditions aren't met — not just visually discouraged. Confirm printed gets set to true on a successful print.
```

**Prompt 3 — Basic Sale History + Reprint**
```
Build a basic sale-history list (just enough to support reprint for now — the full Reports module is Phase 11, don't over-build this) and implement Owner-only reprint per section 3, using assertPermission for sale:reprint. Confirm reprint doesn't touch whatsapp_log or re-trigger any send.
```

**Prompt 4 — Verify**
```
Go through PHASE7.md section 6 acceptance criteria one by one. For criterion 2, specifically try to trigger the print action through a means other than clicking the disabled button (e.g. a direct function call) and confirm it's still rejected.
```
