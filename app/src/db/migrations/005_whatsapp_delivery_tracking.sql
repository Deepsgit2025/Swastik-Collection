-- Real WhatsApp delivery/read tracking for the Connect WhatsApp screen's
-- bill-delivery view (Owner-only). wa_message_id is whatsapp-web.js's own
-- Message.id._serialized, captured right after a successful send so later
-- 'message_ack' events (which only carry that id) can be matched back to the
-- row that logged the send. ack mirrors whatsapp-web.js's MessageAck enum
-- (-1 error, 0 pending, 1 server/sent, 2 device/delivered, 3 read, 4 played);
-- NULL until the first ack event (or for rows sent before this column existed).
ALTER TABLE whatsapp_log ADD COLUMN wa_message_id TEXT;
ALTER TABLE whatsapp_log ADD COLUMN ack INTEGER;
