# PHASE10.md — Dashboard

> Self-contained. Assumes Phases 1–9 complete: sales, payments, and expenses all producing real data. Read CLAUDE.md first.

## 0. What This Phase Is For

Replacing the Phase 1 placeholder dashboards with real, role-aware, at-a-glance numbers. This is a **read-only reporting surface** — no new write operations in this phase.

## 1. Owner Dashboard (`/dashboard`, Owner view)

For "today" by default, with the ability to see the numbers refresh live as new sales/payments/expenses come in during the day (a manual refresh button is acceptable for v1 — real-time push isn't required):

- Today's total sales (grand total across all of today's `sales`)
- Cash vs UPI split for today (sum `cash_amount` and `upi_amount` across today's sales, **plus** today's Payment-In amounts by mode, since those are also cash/UPI money coming in — be careful not to double-count: a credit sale's `credit_amount` is not "cash collected today," it only becomes cash/UPI collected on the day a Payment-In against it happens)
- Salesman-wise breakdown: today's sales total per salesman (group `sales` by `salesman_user_id`, join to `users` for display name)
- Outstanding credit total (sum of all `parties.balance` where positive — this is a snapshot as of now, not scoped to "today")
- Today's expense total (using Phase 9's `getExpensesTotal`)
- Quick links to Sale, Payment-In, Parties, Expenses, Reports

## 2. Salesman Dashboard (`/dashboard`, Salesman view)

- Today's own sales total only (filtered to `salesman_user_id = currentUser.id`)
- Today's own cash vs UPI split only
- **No visibility into other salesmen's numbers, shop-wide totals, outstanding credit, or expense totals** — this is intentionally narrow
- Quick links to Sale (new), Barcode Generator — the two things a Salesman actually does day to day

## 3. Query Functions to Build

- `getTodaysSalesSummary(dateRange?)` → total, cash split, UPI split, credit issued — usable by both dashboard views with a `salesmanUserId` filter param for the Salesman case
- `getSalesmanBreakdown(dateRange)` → array of `{salesmanName, total, cashTotal, upiTotal}` — Owner view only
- `getOutstandingCreditTotal()` → single number, live snapshot
- Reuse Phase 9's `getExpensesTotal`

Keep these as clean, isolated, well-named functions — Phase 11's Reports module will reuse most of this same logic with a date-range parameter instead of hardcoded "today," so avoid writing today-specific one-off queries that Phase 11 has to duplicate or rewrite.

## 4. Permission Wiring

| Data | Owner | Salesman |
|---|---|---|
| Own day's sales total (cash/UPI split) | ✅ | ✅ |
| Other salesmen's totals | ✅ | ❌ |
| Shop-wide totals | ✅ | ❌ |
| Outstanding credit total | ✅ | ❌ |
| Expense total | ✅ | ❌ |

This is enforced by which query functions the Salesman dashboard even calls (it should never call `getSalesmanBreakdown` or `getOutstandingCreditTotal` at all), not just by hiding numbers in the UI after fetching them — don't fetch shop-wide data into a Salesman session and merely choose not to render it, since that data would then sit in memory/dev-tools-visible state unnecessarily. Add `report:view_own` (both roles) vs `report:view_all` (Owner only) checks — these actions already exist as placeholders in Phase 2's table, wire them to real enforcement now.

## 5. Out of Scope This Phase

- Historical/multi-day reporting (Phase 11 — this phase is "today" only, with date-range plumbing built for reuse but not exposed in the UI yet)
- CSV/PDF export (Phase 11)
- Salesman-wise report drill-down into individual sales (Phase 11)

## 6. Acceptance Criteria

1. Owner dashboard numbers match a manual sum of the day's `sales`/`payments`/`expenses` tables exactly
2. Salesman-wise breakdown correctly attributes each sale to the salesman who created it, matching `sales.salesman_user_id`
3. Salesman dashboard shows only their own numbers — verified by checking the Salesman session never calls `getSalesmanBreakdown` or `getOutstandingCreditTotal` (not just that the UI doesn't display them)
4. Cash/UPI split correctly includes today's Payment-In amounts without double-counting credit sales that haven't been paid yet
5. Outstanding credit total matches the sum of all positive `parties.balance` values

## 7. Prompts for Claude Code

**Prompt 1 — Query Functions**
```
Read PHASE10.md fully and CLAUDE.md for permanent rules. Build the query functions in section 3 first, independent of any UI — getTodaysSalesSummary, getSalesmanBreakdown, getOutstandingCreditTotal, reusing Phase 9's getExpensesTotal. Pay close attention to the cash/UPI split note in section 1: Payment-In amounts count as cash/UPI collected on the day they're recorded, but a sale's credit_amount does not count as cash/UPI collected until it's later paid off. Write these functions so Phase 11's Reports module can reuse them with a real date range instead of hardcoded "today."
```

**Prompt 2 — Dashboard Screens**
```
Replace the Phase 1 placeholder dashboards with the real Owner and Salesman dashboards per sections 1-2, using the query functions from Prompt 1. Critically: the Salesman dashboard's code should never call getSalesmanBreakdown or getOutstandingCreditTotal at all, not just choose not to display their results — enforce this by which functions are called in the Salesman code path, not by hiding elements after fetching.
```

**Prompt 3 — Verify**
```
Go through PHASE10.md section 6 acceptance criteria one by one, including manually cross-checking the dashboard numbers against a direct SQL query against sales/payments/expenses for today's date.
```
