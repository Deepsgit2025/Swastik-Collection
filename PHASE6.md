# PHASE6.md — WhatsApp Web Gate (Critical Path)

> Self-contained. Assumes Phases 1–5 complete: full sale-creation flow working end to end (minus printing). Read CLAUDE.md first — this phase implements the single most important business rule in the whole app: **no bill prints until WhatsApp confirms delivery to both the customer and the Owner.**

## 0. What This Phase Is For

Immediately after a sale is saved (Phase 5's `createSale`), this phase generates the bill content and sends it via WhatsApp Web to (a) the customer's number if known, and (b) the Owner's configured number, always. The Print button (built for real in Phase 7) stays disabled until both sends succeed, or the Owner explicitly uses a logged override.

This is the one place in the app where a network-adjacent dependency (a live WhatsApp Web session) gates a core workflow — treat reliability and clear failure states as first-class requirements, not edge cases.

## 1. WhatsApp Session Setup

- Integrate `whatsapp-web.js` (drives a real WhatsApp Web session via Puppeteer) in the Electron main process
- A "Connect WhatsApp" screen (Owner-only — this is session/infra setup, not a daily task): shows a QR code to scan with the shop's WhatsApp-linked phone, same as scanning into WhatsApp Web normally
- **Persist the session** (whatsapp-web.js supports a local auth strategy that saves session data to disk) so the app doesn't need re-scanning every launch — only when the session genuinely expires or is logged out from the phone
- Show connection status clearly somewhere always-visible in the app shell (e.g. a small badge: Connected / Disconnected / Connecting) since every sale depends on this being live

## 2. Bill Content Generation

- On sale completion, generate a bill message/image from the `sales` + `sale_items` data (item names, quantities, prices, discounts, total, payment mode, party name if credit)
- Simple text-message format is acceptable for v1 (itemized list as WhatsApp text) — a rendered image/PDF bill is a nice enhancement but not required to unblock this phase; confirm with the client only if they push back on a plain-text WhatsApp message once they see it, don't pre-build image generation speculatively
- Two sends per sale: to the customer's `parties.phone` (if a party is linked and has a phone number) and to the Owner's number (from `settings` — for this phase, since Phase 12's full Settings module doesn't exist yet, hardcode a temporary settings lookup or a simple config value for the Owner's WhatsApp number, and note clearly in code that Phase 12 will move this into the real Settings screen)

## 3. The Print Gate Logic

- After `createSale` succeeds, trigger both WhatsApp sends automatically, no manual "send" button needed for the normal path
- Log every attempt in `whatsapp_log` (already in the Phase 2 schema): one row per recipient per sale, status `pending` → `sent`/`failed`
- The sale record's `whatsapp_customer_sent` / `whatsapp_owner_sent` flags update to `true` only on confirmed send success
- **Print stays disabled (Phase 7 reads these two flags) until both are true**, with one exception:

### Owner Override
- If a send fails (no customer number on file, session disconnected, WhatsApp API error, etc.), show a clear inline explanation of what failed and why
- An **Owner-only** override toggle/button becomes available in that failure state: "Print anyway" — using it logs a row noting the override (`sales.print_override_used = true`) and which flags were still false at the time
- Salesman has no access to this override under any circumstance — if WhatsApp fails during a Salesman's sale, they must either fix the underlying issue (e.g. get a phone number, wait for reconnection) or get an Owner to authorize the override; a Salesman session should never be able to trigger `print_override_used`

## 4. Handling No Customer Number

- If the linked party has no phone number (or it's a cash sale with no party at all), the customer-side send is skipped by design — `whatsapp_customer_sent` should reflect this cleanly (e.g. treat as automatically satisfied when there's genuinely no number to send to, rather than stuck permanently "pending" for a condition that can never resolve) but the **Owner-side send is always required**, no exceptions, since the Owner always has a configured number
- Make this distinction clear in the UI: "No customer number on file — skipped" reads very differently from "Send failed — WhatsApp disconnected," and the person at the counter needs to immediately understand which one they're looking at

## 5. Permission Wiring

| Action | Owner | Salesman |
|---|---|---|
| Connect/manage WhatsApp session | ✅ | ❌ |
| Trigger the automatic post-sale send | ✅ (implicit) | ✅ (implicit — happens automatically after any sale either role creates) |
| Use print override on send failure | ✅ | ❌ |

Add `whatsapp:manage_session` and `sale:print_override` to the Phase 2 `PERMISSIONS` table.

## 6. Out of Scope This Phase

- The actual Print button and print pipeline (Phase 7 — this phase only produces the two boolean flags that Phase 7's button will check)
- Rendered PDF/image bill generation (plain text is fine for v1 per section 2)
- Real Settings screen for the Owner's WhatsApp number (Phase 12 — use a temporary stand-in per section 2, clearly marked for Phase 12 to replace)

## 7. Acceptance Criteria

1. Scanning the QR code once successfully connects a WhatsApp Web session, and that session survives an app restart without re-scanning
2. Completing a sale with a party that has a phone number results in both `whatsapp_customer_sent` and `whatsapp_owner_sent` becoming true after a live, successful WhatsApp Web test send to a real test number
3. Completing a cash sale with no party results in `whatsapp_customer_sent` being cleanly satisfied (skipped, not stuck pending) while `whatsapp_owner_sent` still requires a real successful send
4. If the WhatsApp session is disconnected during a sale attempt, the failure is shown clearly, distinct from the "no customer number" case
5. Owner override successfully unblocks the print-readiness state and is logged with `print_override_used = true`; the same override action attempted as a Salesman session is rejected by `assertPermission`
6. `whatsapp_log` contains an accurate row per recipient per sale attempt, with correct status values

## 8. Prompts for Claude Code

**Prompt 1 — WhatsApp Session**
```
Read PHASE6.md fully and CLAUDE.md for permanent rules. Integrate whatsapp-web.js in the Electron main process per section 1: QR connect screen (Owner-only), persisted session across restarts, and a visible connection status badge in the app shell. Get a real successful connect-and-persist working before moving to bill sending.
```

**Prompt 2 — Bill Generation + Send**
```
Implement bill content generation per section 2 (plain text itemized message is fine for now) and the two-recipient send flow per section 3 — customer and Owner, triggered automatically right after Phase 5's createSale succeeds. Log every attempt in whatsapp_log and update the sales table's whatsapp_customer_sent / whatsapp_owner_sent flags only on confirmed success. For the Owner's WhatsApp number, use a temporary config value for now — comment clearly that Phase 12 will replace this with a real Settings-backed value.
```

**Prompt 3 — No-Number Handling + Override**
```
Implement section 4 (clean handling of "no customer number" vs a genuine send failure — these need visibly different UI states) and section 3's Owner-only print override, including the assertPermission check and the print_override_used logging. Confirm a Salesman session cannot trigger the override even via a direct backend call.
```

**Prompt 4 — Verify**
```
Go through PHASE6.md section 7 acceptance criteria one by one. For criteria 2 and 4, I'll test with a real WhatsApp number and by manually disconnecting the session — walk me through exactly how to test each scenario.
```
