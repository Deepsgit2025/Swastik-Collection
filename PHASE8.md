# PHASE8.md — Payment In

> Self-contained. Assumes Phases 1–7 complete. Read CLAUDE.md first.

## 0. What This Phase Is For

Recording payments against a party's outstanding credit balance, independent of creating a new sale — e.g. a customer who bought on credit last week comes in just to pay off part of what they owe. **Confirmed: this flow is NOT WhatsApp-gated and has no print step** — it's a simple record-and-done action, unlike the Sale flow in Phases 6–7. Don't build any WhatsApp or print logic into this phase.

## 1. Screen (`/payment-in` or accessible inline from a Party Ledger)

- Party selector (search existing parties — a payment always needs a party, unlike a sale which can be partyless for pure cash)
- Amount field
- Mode: Cash / UPI (no "credit" or "split" option here — a payment simplifies down to just how the money came in)
- Optional note field
- "Record Payment" button — saves and immediately updates the party's balance, no further steps, no gate, no print

## 2. Backend

New function: `recordPayment(user, {partyId, amount, mode, note})`, calling `assertPermission(user.role, 'payment:create')` first (already allowed for both roles per Phase 2's table).

Steps:
1. Validate `amount > 0` and `partyId` exists
2. Insert into `payments`
3. Call Phase 3's `adjustPartyBalance(partyId, -amount)` (payments reduce what's owed)
4. Return the updated party record so the UI can immediately reflect the new balance without a separate refetch

## 3. Party Ledger Integration

Phase 3 already built the combined chronological ledger view expecting both `sales` and `payments` rows — this phase's payments should now show up there automatically once real payment rows exist. Confirm this integration works rather than rebuilding the ledger query.

## 4. Permission Wiring

| Action | Owner | Salesman |
|---|---|---|
| Record a payment | ✅ | ✅ |
| Edit/delete a payment after recording | ✅ | ❌ |

There's no dedicated edit/delete UI for payments built in this phase (not currently in scope per the plan) — if the client wants to correct a mis-entered payment later, that's a scope addition to flag rather than something to build speculatively now. If Claude Code needs a placeholder permission entry for future-proofing, add `payment:edit` / `payment:delete` restricted to `['owner']` in the Phase 2 table, but no screen needs to consume it yet.

## 5. Out of Scope This Phase

- Any WhatsApp send — confirmed not needed for Payment-In
- Any print/receipt generation — confirmed not needed for Payment-In
- Editing or deleting existing payments (see section 4)

## 6. Acceptance Criteria

1. Recording a payment correctly reduces the target party's `balance` by the payment amount, visible immediately in the Party Ledger
2. A payment does not trigger any WhatsApp send (confirm no rows are added to `whatsapp_log` as a result of this flow) and has no print step anywhere in the UI
3. Both Owner and Salesman can record a payment
4. Payment history appears correctly interleaved with sales in the Phase 3 Party Ledger view, in correct chronological order with an accurate running balance
5. Attempting to record a payment with `amount <= 0` or without a valid party is rejected with a clear inline error before reaching the database

## 7. Prompts for Claude Code

**Prompt 1 — Payment-In Screen + Backend**
```
Read PHASE8.md fully and CLAUDE.md for permanent rules — note specifically that Payment-In is NOT WhatsApp-gated and has no print step, unlike the Sale flow. Build the screen per section 1 and the recordPayment backend function per section 2, reusing Phase 3's adjustPartyBalance. Both Owner and Salesman should be able to use this screen.
```

**Prompt 2 — Ledger Integration + Verify**
```
Confirm Phase 3's Party Ledger view correctly picks up real payment rows now that they exist (don't rebuild the ledger query, just verify the integration). Then go through PHASE8.md section 6 acceptance criteria one by one, including explicitly confirming no whatsapp_log rows are created and no print action exists anywhere in this flow.
```
