-- Phase 12 section 2: `backup_log` has existed since 002_core_schema.sql with
-- nothing writing to it. Three columns are added before it gets its first real
-- rows.
--
-- `error` is the important one. Every WhatsApp bug in this project was
-- ultimately diagnosed by reading a table, and the one failure path that left
-- nothing behind but a console.error took two passes and a direct database read
-- to find (see whatsapp_log.error, migration 007). A failed backup that does not
-- say why would be that same mistake on the one table PHASE12.md section 3's
-- day-30 purge is required to trust before it deletes anything.
--
-- `file_name`/`size_bytes` make the Owner's restore list readable, and make a
-- suspiciously small snapshot visible rather than something to infer.
--
-- `status` deliberately keeps its CHECK (status IN ('success','failed')):
-- changing a CHECK means rebuilding the table in SQLite, and nothing here needs
-- a third state. A backup *skipped* because a recent one already succeeded is
-- simply not logged — it was never an attempt.
ALTER TABLE backup_log ADD COLUMN error TEXT;
ALTER TABLE backup_log ADD COLUMN file_name TEXT;
ALTER TABLE backup_log ADD COLUMN size_bytes INTEGER;
