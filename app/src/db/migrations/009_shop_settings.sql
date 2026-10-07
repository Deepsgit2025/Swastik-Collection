-- Phase 12 section 1: the shop header and the Owner's WhatsApp number move out
-- of hardcoded constants (electron/whatsapp/config.ts and src/lib/shopInfo.ts,
-- both deleted with this migration) and into the `settings` key/value table,
-- so the printed bill and the WhatsApp bill image finally read one source
-- instead of two copies in two processes that were free to drift.
--
-- All values seeded as empty strings — the client enters their own shop details
-- and Owner WhatsApp number in Settings on first run. ON CONFLICT DO NOTHING
-- on every row so this is idempotent and can never overwrite a value the Owner
-- has since edited.
INSERT INTO settings (key, value) VALUES ('shop_name', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('shop_address', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('shop_phone', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('owner_whatsapp_number', '') ON CONFLICT(key) DO NOTHING;
