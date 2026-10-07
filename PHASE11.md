# PHASE11.md — Reports

> Self-contained. Assumes Phases 1–10 complete: dashboard query functions (`getTodaysSalesSummary`, `getSalesmanBreakdown`, `getOutstandingCreditTotal`, `getExpensesTotal`) all working with "today" hardcoded. Read CLAUDE.md first.

## 0. What This Phase Is For

Historical and date-range reporting. **Owner-only** — Salesman's reporting needs are already fully met by their Phase 10 dashboard (today's own numbers); this entire module is not reachable by a Salesman session at all, not even in a read-only capacity.

Most of the underlying query logic already exists from Phase 10 — this phase's main job is generalizing "today" into a real date-range parameter and adding export.

## 1. Screens (`/reports`, Owner-only)

### Daily Sales Report
- Date-range picker (default: this month, but freely adjustable)
- Total sales, cash/UPI split, credit issued (sum of `credit_amount` across sales in range), credit collected (sum of `payments.amount` in range) — reuse Phase 10's `getTodaysSalesSummary` generalized to accept any date range instead of just today

### Salesman-wise Sales Report
- Same date-range picker
- Per-salesman totals table (reuse Phase 10's `getSalesmanBreakdown`, generalized to a date range)
- Row click / drill-down → list of that salesman's individual sales in the range (item count, total, payment mode, timestamp) — this drill-down is new in this phase, not present in Phase 10's dashboard version

### Party Outstanding Report
- Simple list: party name, phone, current balance, sorted by balance descending
- This is a live snapshot (not date-ranged, same as Phase 10's `getOutstandingCreditTotal` but now showing the underlying per-party breakdown, not just the sum)

## 2. Export

- CSV export button on each report (Daily Sales, Salesman-wise, Party Outstanding) — straightforward tabular dump matching what's on screen
- PDF export: nice to have, build only if CSV alone doesn't satisfy the client once they see it — don't speculatively build a PDF rendering pipeline if CSV covers the "share with accountant" need, since that's the stated reason for export in the original requirements

## 3. Query Function Changes

Generalize the Phase 10 functions rather than duplicating them:
- `getTodaysSalesSummary(dateRange?)` → rename usage to just pass an explicit `{from, to}` range from the Reports screens (Phase 10's dashboard continues to call it with today's range, no change needed there)
- `getSalesmanBreakdown(dateRange)` → already takes a date range per Phase 10's spec, just needs a drill-down query added: `getSalesmanSales(salesmanUserId, dateRange)` → list of individual sales
- New: `getPartyOutstandingList()` → array of `{partyName, phone, balance}`, sorted descending

## 4. Permission Wiring

| Action | Owner | Salesman |
|---|---|---|
| View any report in this module | ✅ | ❌ |
| Export CSV/PDF | ✅ | ❌ |

Uses `report:view_all` from Phase 2/10's permission table — Salesman has no route to `/reports` at all (route guard rejects, same pattern as every other Owner-only screen), and no report query function in this module should ever be callable from a Salesman session.

## 5. Out of Scope This Phase

- Any change to Salesman's own dashboard (Phase 10) — that stays as is, this module is additive, not a replacement
- Scheduled/automated report emailing or sending — not requested, don't build speculatively

## 6. Acceptance Criteria

1. Daily Sales Report numbers for "today" exactly match the Owner dashboard's Phase 10 numbers when the date range is narrowed to just today — this is the cross-check that the generalized query function didn't introduce a discrepancy from the original
2. Salesman-wise report correctly totals and drills down into individual sales for a selected date range
3. Party Outstanding Report lists every party with a non-zero balance, correctly sorted, matching the sum shown by `getOutstandingCreditTotal`
4. CSV export for each report produces a file whose totals match the on-screen numbers exactly
5. Salesman session has no route to `/reports`, and a direct call to any report query function from a Salesman session is rejected by `assertPermission`

## 7. Prompts for Claude Code

**Prompt 1 — Generalize Queries + Drill-down**
```
Read PHASE11.md fully and CLAUDE.md for permanent rules. Generalize Phase 10's getTodaysSalesSummary and getSalesmanBreakdown to accept an explicit date range (Phase 10's dashboard should keep working unchanged, just now passing today's range explicitly instead of relying on a hardcoded default). Add getSalesmanSales(salesmanUserId, dateRange) for drill-down and getPartyOutstandingList() per section 3.
```

**Prompt 2 — Report Screens**
```
Build the three Owner-only report screens per section 1: Daily Sales Report, Salesman-wise Sales Report (with drill-down), and Party Outstanding Report, each with a date-range picker where applicable. Confirm the route is fully blocked for a Salesman session, not just hidden from nav.
```

**Prompt 3 — CSV Export**
```
Add CSV export per section 2 to each of the three reports, matching the on-screen data exactly. Hold off on PDF export unless I ask for it after seeing the CSV output.
```

**Prompt 4 — Verify**
```
Go through PHASE11.md section 6 acceptance criteria one by one, specifically cross-checking criterion 1 — the Daily Sales Report narrowed to today should produce numbers identical to the Phase 10 Owner dashboard, confirming the generalized query didn't drift from the original.
```
