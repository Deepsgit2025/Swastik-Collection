-- Supersedes the original "compulsory per-line discount column" decision
-- from Phase 5 (see CLAUDE.md) — discount is now applied once, to the whole
-- bill, via the existing `sales.total_discount` column. Per-line discount
-- never shipped to a real UI before this change, so there's no historical
-- data to migrate.
ALTER TABLE sale_items DROP COLUMN discount;
