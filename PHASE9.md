# PHASE9.md — Expenses Module

> Self-contained. Assumes Phases 1–8 complete. Read CLAUDE.md first.

## 0. What This Phase Is For

Simple expense logging. **Confirmed: Salesman has access to log expenses** (add only) — this was revised from an earlier Owner-only assumption, so don't restrict this module to Owner-only.

## 1. Screen (`/expenses`)

- Expense list: category, amount, date, note, logged-by (useful to show since both roles can log — helps the Owner see who logged what), with a date-range filter
- "Add Expense" form: category (simple text or a small fixed dropdown — e.g. Rent, Electricity, Staff, Misc; confirm exact categories with the client if they care, otherwise ship with a reasonable default set plus "Other"), amount, date (defaults to today), note
- **No edit or delete controls anywhere on this screen for either role in the UI** — Owner has the underlying permission (see section 3) but no screen is being built for it in this phase since it's not currently a requested feature; if the client wants Owner edit/delete later, that's a small follow-up to this phase, not a redesign

## 2. Backend

New function: `logExpense(user, {category, amount, date, note})`, calling `assertPermission(user.role, 'expense:create')` first (allowed for both roles per Phase 2's table, per the confirmed decision reversing the earlier Owner-only assumption).

## 3. Permission Wiring

| Action | Owner | Salesman |
|---|---|---|
| View expense list | ✅ | ✅ |
| Log a new expense | ✅ | ✅ |
| Edit/delete an expense | ✅ (permission exists, no UI built yet) | ❌ |

Confirm the Phase 2 `PERMISSIONS` table has `expense:create: ['owner', 'salesman']` — if Phase 2 was built before this decision was finalized, this is the phase to correct it if it's still showing Owner-only.

## 4. Dashboard Note (relevant for Phase 10, not built here)

Expense totals will roll into the Owner's dashboard in Phase 10 — this phase just needs to make sure `logExpense` and the list query are solid and easy for Phase 10 to sum against (a simple `getExpensesTotal(dateRange)` query function is worth building now so Phase 10 doesn't duplicate the logic).

## 5. Out of Scope This Phase

- Edit/delete UI (see section 1)
- Dashboard integration (Phase 10 consumes this module's data, doesn't get built here)
- Any linkage between expenses and specific sales/parties — expenses are standalone records

## 6. Acceptance Criteria

1. Salesman has a visible Expenses nav item, can log a new expense, and sees the full expense list (not filtered to just their own entries — this is shop-wide financial visibility, same reasoning as barcode labels in Phase 4)
2. Salesman has no edit/delete controls anywhere on the Expenses screen
3. A direct backend call attempting to edit/delete an expense as Salesman is rejected by `assertPermission` (even though no UI reaches this path, the backend rule must hold independently)
4. Date-range filter on the expense list correctly narrows results
5. `getExpensesTotal(dateRange)` returns an accurate sum, ready for Phase 10 to consume directly

## 7. Prompts for Claude Code

**Prompt 1 — Expenses Screen + Backend**
```
Read PHASE9.md fully and CLAUDE.md for permanent rules — note specifically that Salesman DOES have access to log expenses (add only), this was revised from an Owner-only assumption. Build the expense list + add-expense form per section 1, and logExpense per section 2. If Phase 2's PERMISSIONS table currently restricts expense:create to owner-only, correct it to allow both roles.
```

**Prompt 2 — Total Query + Verify**
```
Add the getExpensesTotal(dateRange) query function per section 4, ready for Phase 10 to consume. Then go through PHASE9.md section 6 acceptance criteria one by one, including confirming a direct backend edit/delete call as Salesman is rejected even though no UI path to it exists.
```
