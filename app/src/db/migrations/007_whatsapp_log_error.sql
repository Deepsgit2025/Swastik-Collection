-- Why a send failed, in the sender's own words, kept alongside the row that
-- recorded the attempt. Until now a failure left nothing behind but a
-- console.error in the main process — invisible to the Owner, who saw only
-- "Not delivered" with no way to tell a wrong phone number apart from a
-- dropped session apart from a WhatsApp Web internals change. NULL for every
-- pending/sent row and for rows written before this column existed.
ALTER TABLE whatsapp_log ADD COLUMN error TEXT;
