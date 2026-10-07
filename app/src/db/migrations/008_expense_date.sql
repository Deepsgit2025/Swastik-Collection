-- The date an expense was *incurred*, as distinct from `created_at` (when the
-- row was typed in). PHASE9.md section 1 puts a date field on the add-expense
-- form defaulting to today, which only means something if it can also be set
-- to a past day — rent handed over yesterday, logged this morning. The
-- date-range filter and Phase 10's `getExpensesTotal` both read this column,
-- not `created_at`, so a back-dated expense lands in the period it belongs to.
--
-- Stored as 'YYYY-MM-DD' (no time component) — an expense is a day, not an
-- instant, and a plain date string compares correctly with BETWEEN.
--
-- Declared nullable on purpose: SQLite's ALTER TABLE ADD COLUMN only accepts a
-- *constant* DEFAULT, so `NOT NULL DEFAULT (date('now'))` is rejected outright
-- and a bare NOT NULL would fail against any existing row. Non-nullness is
-- held by `logExpense`, which is the only writer and always supplies a
-- validated date, plus the backfill below for rows predating this column.
ALTER TABLE expenses ADD COLUMN expense_date TEXT;

UPDATE expenses SET expense_date = date(created_at) WHERE expense_date IS NULL;
