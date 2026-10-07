# PHASE3.md — Parties Module

> Self-contained. Assumes Phases 1–2 are complete: auth, role guard, full schema, and the `assertPermission` wrapper all working. Read CLAUDE.md first.

## 0. What This Phase Is For

Parties = customer/credit-account records. There is no supplier or purchase concept in this app (confirmed permanently out of scope), so "Parties" here means customers only, despite the generic naming in the schema.

## 1. Screens to Build

### Party List (`/parties`)
- Table: name, phone, balance (highlight non-zero balances), created date
- Search by name/phone
- Filter: "Show only parties with balance due"
- Row click → Party Ledger view
- "Add Party" button — visible to both roles, but behavior differs (see below)

### Add/Edit Party
- **Owner**: full form — name, phone, address, opening balance if needed
- **Salesman**: quick-add only — name + phone fields only, no address/balance fields, and this quick-add is only reachable **from within the sale flow** (a "+ New Party" inline action during checkout), not as a standalone nav destination. Salesman does not get a general "Add Party" screen with a full form.
- Edit is Owner-only. If a Salesman is looking at the Party List, there is no Edit button rendered on any row, and the edit route rejects a Salesman session even if navigated to directly (via `RequireRole` + `assertPermission('party:edit', ...)` on the backend call).

### Party Ledger (`/parties/:id`)
- Party details header (name, phone, current balance)
- Chronological list combining: sales linked to this party (credit or otherwise) and payments recorded against them
- Running balance shown per row so the Owner can see how the balance moved over time
- No edit/delete controls on ledger entries themselves — those belong to the Sale/Payment modules in later phases, this is a read view

## 2. Permission Wiring (uses Phase 2's `assertPermission`)

| Action | Owner | Salesman |
|---|---|---|
| View party list | ✅ | ✅ |
| View party ledger | ✅ | ✅ |
| Full add/edit party (name, phone, address, balance) | ✅ | ❌ |
| Quick-add party (name + phone, from sale flow only) | ✅ (can also use quick-add if they want) | ✅ |
| Delete party | ✅ | ❌ |

Backend functions to build: `createParty(user, data)`, `quickAddParty(user, {name, phone})`, `updateParty(user, id, data)`, `deleteParty(user, id)`, `getParties(filters)`, `getPartyLedger(partyId)`. Every write function calls `assertPermission` first per the Phase 2 pattern — do not special-case Parties with its own permission logic.

Note: `quickAddParty` uses the `party:create` action (both roles allowed per Phase 2's table) but should be a distinct function from `createParty` even though both write to the same table — this keeps the "Salesman only gets name+phone, no other fields" rule enforced at the function signature level, not just hidden in the UI. `createParty` (full form) should still technically be reachable by `assertPermission` for a salesman role since the Phase 2 table allows `party:create` for both — but the **full-form screen itself is not rendered or routed to for Salesman**, so in practice they can only ever call `quickAddParty`. Don't rely on the permission table alone to block field-level restrictions; that's a UI/route-level concern layered on top.

## 3. Balance Calculation

Party `balance` on the `parties` table is a running cache column (already in the Phase 2 schema), not computed live on every read. Update rules:
- Credit sale created against a party → increase `balance` by `credit_amount`
- Payment recorded against a party → decrease `balance` by payment `amount`
- These updates don't fully wire up until Phase 5 (Sale) and Phase 8 (Payment-In) actually create sales/payments — for this phase, build the update function (`adjustPartyBalance(partyId, delta)`) and unit-test it in isolation, since Phases 5 and 8 will call it directly.

## 4. Out of Scope This Phase

- No sale creation yet (Phase 5) — the ledger view will be empty of sale rows until then, that's expected
- No payment recording yet (Phase 8)
- Don't build the "quick-add from sale flow" UI trigger itself yet since the sale screen doesn't exist — build `quickAddParty` as a backend function and a reusable modal/form component now, so Phase 5 can drop it in without rebuilding it

## 5. Acceptance Criteria

1. Owner can create a full party record with all fields; Salesman has no route/button to reach that full-form screen
2. `quickAddParty` backend function works for both roles when called directly (proving the permission table is correct), even though only Salesman-facing sale-flow UI will actually invoke it in practice
3. Owner can edit and delete a party; attempting the same via a direct backend call as Salesman throws a `PermissionError` from `assertPermission`
4. Party list search and balance-due filter both work correctly against seeded test data
5. Party ledger correctly shows a combined, chronological, running-balance view (test this with manually inserted dummy sale/payment rows even though Phases 5/8 aren't built yet — insert directly into `sales`/`payments` via a test script to verify the ledger query logic)
6. `adjustPartyBalance` correctly increases/decreases the cached `balance` column and this is covered by a unit test

## 6. Prompts for Claude Code

**Prompt 1 — Party List + Ledger (read side first)**
```
Read PHASE3.md fully, and CLAUDE.md for permanent project rules. Build the Party List screen and Party Ledger screen described in section 1 — read-only for now. For the ledger, write a test script that inserts a few dummy rows directly into the sales and payments tables (bypassing the UI, since those modules don't exist yet) so you can verify the combined chronological running-balance view works correctly. Both roles should be able to view these screens per the section 2 permission table.
```

**Prompt 2 — Party Write Operations**
```
Now build createParty, quickAddParty, updateParty, and deleteParty as described in sections 1-2, each calling assertPermission first per the Phase 2 pattern. Build the quick-add as a reusable modal/form component now even though the sale flow that will trigger it doesn't exist until Phase 5 — Phase 5 needs to be able to drop this in without rebuilding it. Confirm Salesman has no UI path to the full add/edit form, only ever to quick-add.
```

**Prompt 3 — Balance Logic**
```
Implement adjustPartyBalance per section 3, and add a unit test that creates a party, applies a credit-sale-style increase and a payment-style decrease, and confirms the balance column ends up correct.
```

**Prompt 4 — Verify**
```
Go through PHASE3.md section 5 acceptance criteria one by one, including confirming a direct backend call to updateParty/deleteParty as Salesman throws a PermissionError rather than silently succeeding or only being blocked in the UI.
```