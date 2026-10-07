-- Audit trail for the Owner-only print override (PHASE6.md section 3 /
-- PHASE7.md section 2): print_override_used alone (added in 002) says
-- *whether* an override happened, but not who used it or which WhatsApp
-- flags were still false at the moment they did. These columns are only
-- ever set once, together, by usePrintOverride (src/db/sales.ts) — never by
-- ordinary sale creation or printing.
ALTER TABLE sales ADD COLUMN print_override_by_user_id INTEGER REFERENCES users(id);
ALTER TABLE sales ADD COLUMN print_override_customer_sent_at_use INTEGER;
ALTER TABLE sales ADD COLUMN print_override_owner_sent_at_use INTEGER;
ALTER TABLE sales ADD COLUMN print_override_at TEXT;
