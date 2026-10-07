-- Salesman becomes a *record*, not a login (client decision, 2026-08-27).
--
-- Until now a Salesman was a `users` row and attribution came from whoever was
-- logged in (`sales.salesman_user_id`). The shop asked for the opposite: no
-- salesman login at all, the app open at the counter, and the person who made
-- the sale picked from a dropdown on the bill. So who-gets-the-credit moves
-- out of `users` and into its own table, which carries no password, no role
-- and no ability to log in.
--
-- `sales.salesman_user_id` is deliberately left in place and NOT NULL. It now
-- means "which session recorded this bill" (the counter, or the Owner while
-- elevated) rather than who sold it. Dropping it would break every historical
-- row's foreign key for no gain.

CREATE TABLE IF NOT EXISTS salesmen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,   -- soft-disable only; old sales still point here
  -- Set only by this migration's backfill, so the link from an old sale back to
  -- the `users` row that made it stays inspectable afterwards. Null for every
  -- salesman the Owner adds from Settings later.
  legacy_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE sales ADD COLUMN salesman_id INTEGER REFERENCES salesmen(id);

-- Backfill, so no history is lost: one `salesmen` row per user who has ever
-- made a sale — Owners included, since an Owner ringing up a bill is a real
-- salesman for reporting purposes — then map every existing bill through it.
INSERT INTO salesmen (name, is_active, legacy_user_id)
SELECT u.full_name, u.is_active, u.id
FROM users u
WHERE EXISTS (SELECT 1 FROM sales s WHERE s.salesman_user_id = u.id);

UPDATE sales
SET salesman_id = (SELECT sm.id FROM salesmen sm WHERE sm.legacy_user_id = sales.salesman_user_id)
WHERE salesman_id IS NULL;

-- The logins stop working. The rows stay: `sales.salesman_user_id`,
-- `payments.recorded_by_user_id`, `expenses.logged_by_user_id`,
-- `parties.created_by_user_id` and the print-override log all reference them,
-- and `verifyOwnerPassword` only ever considers `role = 'owner'` rows anyway.
-- The reserved counter account is created after seeding, in `ensureCounterUser`
-- (src/db/seed.ts), so it is unaffected by this.
UPDATE users SET is_active = 0 WHERE role = 'salesman';

CREATE INDEX IF NOT EXISTS idx_sales_salesman_id ON sales(salesman_id);
